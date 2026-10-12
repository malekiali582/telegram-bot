import type { Database, Executor } from '@lulu/database';
import { adminLoginAttempts, adminUsers, auditLogs, inTransaction } from '@lulu/database';
import { lockKey } from '@lulu/domain';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { AdminRole } from '../contract.ts';
import { normalizeUsername } from './admins.ts';
import { PASSWORD_MAX_LENGTH, dummyPasswordHash, verifyPassword } from './password.ts';
import type { NewSession } from './sessions.ts';
import { createSession, pruneSessions } from './sessions.ts';

/**
 * Login with attempt limits kept in PostgreSQL (no Redis). Failures count per username
 * and per IP since the last success, within the last hour. Past a free allowance each
 * further failure doubles the wait (30 s, 1 min, 2 min … up to 15 min). While a wait is
 * running the password is not even checked, and the attempt is not recorded, so a
 * locked-out attacker cannot extend or probe anything.
 *
 * Attempts for one username are serialized by an advisory lock, so parallel guesses
 * cannot slip past the limit.
 */

export const LOGIN_LIMITS = {
  windowMs: 60 * 60_000,
  freeFailuresPerUsername: 5,
  freeFailuresPerIp: 20,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
} as const;

export function lockoutMs(failures: number, freeFailures: number): number {
  if (failures < freeFailures) return 0;
  const doublings = Math.min(failures - freeFailures, 20);
  return Math.min(LOGIN_LIMITS.maxDelayMs, LOGIN_LIMITS.baseDelayMs * 2 ** doublings);
}

async function failuresSinceSuccess(
  ex: Executor,
  column: typeof adminLoginAttempts.username | typeof adminLoginAttempts.ip,
  value: string,
  now: Date,
): Promise<{ failures: number; lastFailureAt: Date | null }> {
  const since = new Date(now.getTime() - LOGIN_LIMITS.windowMs);
  const [lastSuccess] = await ex
    .select({ at: adminLoginAttempts.attemptedAt })
    .from(adminLoginAttempts)
    .where(
      and(
        eq(column, value),
        eq(adminLoginAttempts.succeeded, true),
        gt(adminLoginAttempts.attemptedAt, since),
      ),
    )
    .orderBy(desc(adminLoginAttempts.attemptedAt))
    .limit(1);
  const from = lastSuccess?.at ?? since;
  const [row] = await ex
    .select({
      failures: sql<number>`count(*)::int`,
      last: sql<Date | string | null>`max(${adminLoginAttempts.attemptedAt})`,
    })
    .from(adminLoginAttempts)
    .where(
      and(
        eq(column, value),
        eq(adminLoginAttempts.succeeded, false),
        gt(adminLoginAttempts.attemptedAt, from),
      ),
    );
  return {
    failures: row?.failures ?? 0,
    lastFailureAt: row?.last ? new Date(row.last) : null,
  };
}

/** Milliseconds until another attempt is allowed for this username and IP (0 = now). */
export async function loginWaitMs(
  ex: Executor,
  username: string,
  ip: string,
  now: Date,
): Promise<number> {
  const checks = [
    [adminLoginAttempts.username, username, LOGIN_LIMITS.freeFailuresPerUsername],
    [adminLoginAttempts.ip, ip, LOGIN_LIMITS.freeFailuresPerIp],
  ] as const;
  let wait = 0;
  for (const [column, value, free] of checks) {
    const { failures, lastFailureAt } = await failuresSinceSuccess(ex, column, value, now);
    if (!lastFailureAt) continue;
    const until = lastFailureAt.getTime() + lockoutMs(failures, free);
    wait = Math.max(wait, until - now.getTime());
  }
  return wait;
}

export type LoginResult =
  | {
      status: 'ok';
      session: NewSession;
      admin: { id: number; username: string; role: AdminRole };
    }
  | { status: 'invalid_credentials' }
  | { status: 'locked'; retryAfterMs: number };

export async function login(
  db: Database,
  input: {
    username: string;
    password: string;
    ip: string;
    userAgent: string | undefined;
    now: Date;
    secret: string;
    requestId: string;
  },
): Promise<LoginResult> {
  // Stored lower-case and bounded, so a huge or odd username cannot bloat the table.
  const username = normalizeUsername(input.username).slice(0, 64);
  const { now } = input;

  return inTransaction(db, async (tx) => {
    await lockKey(tx, `admin-login:${username}`);
    const retryAfterMs = await loginWaitMs(tx, username, input.ip, now);
    if (retryAfterMs > 0) return { status: 'locked' as const, retryAfterMs };

    const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.username, username));
    const passwordOk =
      input.password.length <= PASSWORD_MAX_LENGTH &&
      (await verifyPassword(input.password, admin?.passwordHash ?? (await dummyPasswordHash())));
    const ok = admin !== undefined && admin.disabledAt === null && passwordOk;

    await tx
      .insert(adminLoginAttempts)
      .values({ username, ip: input.ip, attemptedAt: now, succeeded: ok });
    if (!ok || !admin) return { status: 'invalid_credentials' as const };

    const session = await createSession(tx, {
      adminUserId: admin.id,
      secret: input.secret,
      now,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: admin.id,
      action: 'auth.login',
      targetType: 'admin_user',
      targetId: String(admin.id),
      details: { ip: input.ip },
      requestId: input.requestId,
      createdAt: now,
    });
    await pruneSessions(tx, now);
    await tx
      .delete(adminLoginAttempts)
      .where(lt(adminLoginAttempts.attemptedAt, new Date(now.getTime() - 30 * 24 * 60 * 60_000)));
    return {
      status: 'ok' as const,
      session,
      admin: { id: admin.id, username: admin.username, role: admin.role },
    };
  });
}
