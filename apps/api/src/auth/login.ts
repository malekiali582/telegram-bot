import type { GameConfig } from '@lulu/config';
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
 * Login with attempt limits kept in PostgreSQL (no Redis), set by the `admin.*`
 * configuration (suggested values, docs/assumptions.md). Failures count per username
 * and per IP since the last success, within the window. Past the allowed failures each
 * further one doubles the wait (30 s, 1 min, 2 min … up to the window length). While a
 * wait is running the password is not even checked and the attempt is not recorded, so
 * a locked-out attacker can neither extend nor probe anything.
 *
 * Attempts for one username are serialized by an advisory lock, so parallel guesses
 * cannot slip past the limit. Re-entering the password for a sensitive action counts
 * the same way, so it is no side door for guessing.
 */

export interface LoginPolicy {
  windowMs: number;
  /** Failures allowed per username and per IP within the window before waits start. */
  freeFailures: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sessionTtlMs: number;
}

export function loginPolicy(config: GameConfig): LoginPolicy {
  const windowMs = config.admin.loginWindowMinutes * 60_000;
  return {
    windowMs,
    freeFailures: config.admin.loginMaxAttempts,
    baseDelayMs: 30_000,
    maxDelayMs: Math.max(30_000, windowMs),
    sessionTtlMs: config.admin.sessionTtlHours * 3_600_000,
  };
}

export function lockoutMs(failures: number, policy: LoginPolicy): number {
  if (failures < policy.freeFailures) return 0;
  const doublings = Math.min(failures - policy.freeFailures, 20);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** doublings);
}

async function failuresSinceSuccess(
  ex: Executor,
  column: typeof adminLoginAttempts.username | typeof adminLoginAttempts.ip,
  value: string,
  now: Date,
  windowMs: number,
): Promise<{ failures: number; lastFailureAt: Date | null }> {
  const since = new Date(now.getTime() - windowMs);
  // "After the last success" by insertion order, not time: equal timestamps are possible.
  const [lastSuccess] = await ex
    .select({ id: adminLoginAttempts.id })
    .from(adminLoginAttempts)
    .where(
      and(
        eq(column, value),
        eq(adminLoginAttempts.succeeded, true),
        gt(adminLoginAttempts.attemptedAt, since),
      ),
    )
    .orderBy(desc(adminLoginAttempts.id))
    .limit(1);
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
        gt(adminLoginAttempts.attemptedAt, since),
        lastSuccess ? gt(adminLoginAttempts.id, lastSuccess.id) : undefined,
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
  policy: LoginPolicy,
): Promise<number> {
  let wait = 0;
  for (const [column, value] of [
    [adminLoginAttempts.username, username],
    [adminLoginAttempts.ip, ip],
  ] as const) {
    const { failures, lastFailureAt } = await failuresSinceSuccess(
      ex,
      column,
      value,
      now,
      policy.windowMs,
    );
    if (!lastFailureAt) continue;
    const until = lastFailureAt.getTime() + lockoutMs(failures, policy);
    wait = Math.max(wait, until - now.getTime());
  }
  return wait;
}

interface AttemptInput {
  username: string;
  password: string;
  ip: string;
  now: Date;
  policy: LoginPolicy;
}

type AttemptResult =
  | { status: 'ok'; admin: typeof adminUsers.$inferSelect }
  | { status: 'invalid_credentials' }
  | { status: 'locked'; retryAfterMs: number };

/** One limited, recorded password check inside the caller's transaction. */
async function attempt(ex: Executor, input: AttemptInput): Promise<AttemptResult> {
  const { username } = input;
  const retryAfterMs = await loginWaitMs(ex, username, input.ip, input.now, input.policy);
  if (retryAfterMs > 0) return { status: 'locked', retryAfterMs };

  const [admin] = await ex.select().from(adminUsers).where(eq(adminUsers.username, username));
  const passwordOk =
    input.password.length <= PASSWORD_MAX_LENGTH &&
    (await verifyPassword(input.password, admin?.passwordHash ?? (await dummyPasswordHash())));
  const ok = admin !== undefined && admin.disabledAt === null && passwordOk;
  await ex
    .insert(adminLoginAttempts)
    .values({ username, ip: input.ip, attemptedAt: input.now, succeeded: ok });
  return ok && admin ? { status: 'ok', admin } : { status: 'invalid_credentials' };
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
    policy: LoginPolicy;
  },
): Promise<LoginResult> {
  // Stored lower-case and bounded, so a huge or odd username cannot bloat the table.
  const username = normalizeUsername(input.username).slice(0, 64);
  const { now } = input;

  return inTransaction(db, async (tx) => {
    await lockKey(tx, `admin-login:${username}`);
    const result = await attempt(tx, { ...input, username });
    if (result.status !== 'ok') return result;
    const { admin } = result;

    const session = await createSession(tx, {
      adminUserId: admin.id,
      secret: input.secret,
      now,
      ttlMs: input.policy.sessionTtlMs,
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

/**
 * «Enter your password again» before a sensitive action (backups, managing admins,
 * changing owner rules). Limited and recorded exactly like a login.
 */
export async function confirmPassword(
  db: Database,
  input: { username: string; password: string; ip: string; now: Date; policy: LoginPolicy },
): Promise<
  { status: 'ok' } | { status: 'wrong_password' } | { status: 'locked'; retryAfterMs: number }
> {
  return inTransaction(db, async (tx) => {
    await lockKey(tx, `admin-login:${input.username}`);
    const result = await attempt(tx, input);
    if (result.status === 'ok') return { status: 'ok' as const };
    if (result.status === 'locked') return result;
    return { status: 'wrong_password' as const };
  });
}
