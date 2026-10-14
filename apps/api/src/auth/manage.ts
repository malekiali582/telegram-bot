import type { Database, Executor, Tx } from '@lulu/database';
import { adminSessions, adminUsers, auditLogs, inTransaction, queryRows } from '@lulu/database';
import { lockKey } from '@lulu/domain';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AdminRole } from '../contract.ts';
import type { CreateAdminResult } from './admins.ts';
import { activeOwners, createAdminUser, normalizeUsername } from './admins.ts';
import { checkNewPassword, hashPassword } from './password.ts';
import { revokeAdminSessions, revokeSession } from './sessions.ts';

/**
 * Managing panel accounts (owner only) and one's own account. An admin is never deleted:
 * the audit log, config versions and announcements keep pointing at them, so «removing»
 * disables the account and ends its sessions. Every change takes the `admin-users` lock,
 * so two owners acting at once can never leave the panel without an active owner.
 */

export interface AdminListItem {
  id: number;
  username: string;
  role: AdminRole;
  createdAt: Date;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  activeSessions: number;
}

export async function listAdmins(
  db: Database,
  now: Date,
  idleMs: number,
): Promise<AdminListItem[]> {
  const idleSince = new Date(now.getTime() - idleMs).toISOString();
  const rows = await queryRows<{
    id: string | number;
    username: string;
    role: AdminRole;
    created_at: Date | string;
    disabled_at: Date | string | null;
    last_login_at: Date | string | null;
    active_sessions: number;
  }>(
    db,
    sql`SELECT u.id, u.username, u.role, u.created_at, u.disabled_at,
               (SELECT max(created_at) FROM audit_logs a
                 WHERE a.action = 'auth.login' AND a.admin_user_id = u.id) AS last_login_at,
               (SELECT count(*)::int FROM admin_sessions s
                 WHERE s.admin_user_id = u.id AND s.revoked_at IS NULL
                   AND s.expires_at > ${now.toISOString()}::timestamptz
                   AND s.last_seen_at > ${idleSince}::timestamptz) AS active_sessions
          FROM admin_users u
         ORDER BY u.disabled_at IS NOT NULL, u.role = 'admin', u.username`,
  );
  const date = (v: Date | string | null) => (v === null ? null : new Date(v));
  return rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    role: r.role,
    createdAt: new Date(r.created_at),
    disabledAt: date(r.disabled_at),
    lastLoginAt: date(r.last_login_at),
    activeSessions: r.active_sessions,
  }));
}

interface Actor {
  /** The owner doing it. */
  actorId: number;
  requestId?: string;
  now: Date;
}

const audit = (
  tx: Executor,
  actor: Actor,
  action: string,
  targetId: number,
  details: Record<string, unknown> = {},
  reason: string | null = null,
) =>
  tx.insert(auditLogs).values({
    actor: 'admin',
    adminUserId: actor.actorId,
    action,
    targetType: 'admin_user',
    targetId: String(targetId),
    reason,
    details,
    requestId: actor.requestId ?? null,
    createdAt: actor.now,
  });

export async function addAdmin(
  db: Database,
  input: Actor & { username: string; password: string; role: AdminRole },
): Promise<CreateAdminResult> {
  return inTransaction(db, async (tx) => {
    await lockKey(tx, 'admin-users');
    const result = await createAdminUser(tx, input);
    if (result.status === 'ok') {
      await audit(tx, input, 'admin.create', result.adminUserId, {
        username: normalizeUsername(input.username),
        role: input.role,
      });
    }
    return result;
  });
}

export type AdminChangeResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'unchanged' }
  /** The change would leave no active owner. */
  | { status: 'last_owner' }
  /** Disabling oneself, or resetting one's own password here (use the account page). */
  | { status: 'self' };

async function lockedTarget(tx: Tx, id: number) {
  await lockKey(tx, 'admin-users');
  const [row] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id));
  return row;
}

/** Whether `targetId` is the only active owner. */
async function isLastOwner(tx: Executor, targetId: number): Promise<boolean> {
  const owners = await activeOwners(tx);
  return owners.length === 1 && owners[0]!.id === targetId;
}

export async function setAdminRole(
  db: Database,
  input: Actor & { targetId: number; role: AdminRole },
): Promise<AdminChangeResult> {
  return inTransaction(db, async (tx) => {
    const target = await lockedTarget(tx, input.targetId);
    if (!target) return { status: 'not_found' as const };
    if (target.role === input.role) return { status: 'unchanged' as const };
    if (
      target.role === 'owner' &&
      target.disabledAt === null &&
      (await isLastOwner(tx, target.id))
    ) {
      return { status: 'last_owner' as const };
    }
    await tx.update(adminUsers).set({ role: input.role }).where(eq(adminUsers.id, target.id));
    await audit(tx, input, 'admin.role', target.id, {
      username: target.username,
      from: target.role,
      to: input.role,
    });
    return { status: 'ok' as const };
  });
}

export async function setAdminDisabled(
  db: Database,
  input: Actor & { targetId: number; disabled: boolean; reason: string },
): Promise<AdminChangeResult> {
  const reason = input.reason.trim().slice(0, 500) || null;
  return inTransaction(db, async (tx) => {
    const target = await lockedTarget(tx, input.targetId);
    if (!target) return { status: 'not_found' as const };
    if ((target.disabledAt !== null) === input.disabled) return { status: 'unchanged' as const };
    if (input.disabled) {
      if (target.id === input.actorId) return { status: 'self' as const };
      if (target.role === 'owner' && (await isLastOwner(tx, target.id))) {
        return { status: 'last_owner' as const };
      }
    }
    await tx
      .update(adminUsers)
      .set({ disabledAt: input.disabled ? input.now : null })
      .where(eq(adminUsers.id, target.id));
    if (input.disabled) await revokeAdminSessions(tx, target.id, input.now);
    await audit(
      tx,
      input,
      input.disabled ? 'admin.disable' : 'admin.enable',
      target.id,
      { username: target.username },
      reason,
    );
    return { status: 'ok' as const };
  });
}

export type PasswordChangeResult =
  AdminChangeResult | { status: 'weak_password'; problem: 'too_short' | 'too_long' };

/** An owner sets a new password for another admin; all of that admin's sessions end. */
export async function setAdminPassword(
  db: Database,
  input: Actor & { targetId: number; password: string },
): Promise<PasswordChangeResult> {
  if (input.targetId === input.actorId) return { status: 'self' };
  const problem = checkNewPassword(input.password);
  if (problem) return { status: 'weak_password', problem };
  const passwordHash = await hashPassword(input.password);
  return inTransaction(db, async (tx) => {
    const target = await lockedTarget(tx, input.targetId);
    if (!target) return { status: 'not_found' as const };
    await tx.update(adminUsers).set({ passwordHash }).where(eq(adminUsers.id, target.id));
    await revokeAdminSessions(tx, target.id, input.now);
    await audit(tx, input, 'admin.password_reset', target.id, { username: target.username });
    return { status: 'ok' as const };
  });
}

/**
 * One's own new password (the current one was checked by the caller). Every other
 * session of the account ends; the one making the change stays signed in.
 */
export async function changeOwnPassword(
  db: Database,
  input: {
    adminUserId: number;
    password: string;
    keepTokenHash: string;
    requestId?: string;
    now: Date;
  },
): Promise<{ status: 'ok' } | { status: 'weak_password'; problem: 'too_short' | 'too_long' }> {
  const problem = checkNewPassword(input.password);
  if (problem) return { status: 'weak_password', problem };
  const passwordHash = await hashPassword(input.password);
  return inTransaction(db, async (tx) => {
    await tx.update(adminUsers).set({ passwordHash }).where(eq(adminUsers.id, input.adminUserId));
    await revokeAdminSessions(tx, input.adminUserId, input.now, input.keepTokenHash);
    await audit(
      tx,
      {
        actorId: input.adminUserId,
        now: input.now,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
      'account.password',
      input.adminUserId,
    );
    return { status: 'ok' as const };
  });
}

export interface SessionItem {
  /** A short public handle for the session; never the token or its full hash. */
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

const SESSION_ID_LENGTH = 16;
const sessionId = (tokenHash: string) => tokenHash.slice(0, SESSION_ID_LENGTH);

/** The account's live sessions, newest activity first. */
export async function listOwnSessions(
  db: Database,
  input: { adminUserId: number; currentTokenHash: string; now: Date; idleMs: number },
): Promise<SessionItem[]> {
  const rows = await db
    .select()
    .from(adminSessions)
    .where(
      and(
        eq(adminSessions.adminUserId, input.adminUserId),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, input.now),
        gt(adminSessions.lastSeenAt, new Date(input.now.getTime() - input.idleMs)),
      ),
    );
  return rows
    .map((s) => ({
      id: sessionId(s.tokenHash),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.tokenHash === input.currentTokenHash,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || +b.lastSeenAt - +a.lastSeenAt);
}

/** Signs out one other session of the account (the current one uses logout). */
export async function revokeOwnSession(
  db: Database,
  input: {
    adminUserId: number;
    sessionId: string;
    currentTokenHash: string;
    requestId?: string;
    now: Date;
  },
): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'current' }> {
  if (!/^[0-9a-f]{16}$/.test(input.sessionId)) return { status: 'not_found' };
  if (sessionId(input.currentTokenHash) === input.sessionId) return { status: 'current' };
  return inTransaction(db, async (tx) => {
    const [row] = await tx
      .select({ tokenHash: adminSessions.tokenHash })
      .from(adminSessions)
      .where(
        and(
          eq(adminSessions.adminUserId, input.adminUserId),
          isNull(adminSessions.revokedAt),
          sql`left(${adminSessions.tokenHash}, ${SESSION_ID_LENGTH}) = ${input.sessionId}`,
        ),
      );
    if (!row) return { status: 'not_found' as const };
    await revokeSession(tx, row.tokenHash, input.now);
    await audit(
      tx,
      {
        actorId: input.adminUserId,
        now: input.now,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
      'account.session_revoke',
      input.adminUserId,
      { session: input.sessionId },
    );
    return { status: 'ok' as const };
  });
}

/** Signs out every other session of the account. */
export async function revokeOtherSessions(
  db: Database,
  input: { adminUserId: number; currentTokenHash: string; requestId?: string; now: Date },
): Promise<{ revoked: number }> {
  return inTransaction(db, async (tx) => {
    const rows = await tx
      .update(adminSessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(adminSessions.adminUserId, input.adminUserId),
          isNull(adminSessions.revokedAt),
          sql`${adminSessions.tokenHash} <> ${input.currentTokenHash}`,
        ),
      )
      .returning({ tokenHash: adminSessions.tokenHash });
    if (rows.length > 0) {
      await audit(
        tx,
        {
          actorId: input.adminUserId,
          now: input.now,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        'account.sessions_revoke_others',
        input.adminUserId,
        { revoked: rows.length },
      );
    }
    return { revoked: rows.length };
  });
}
