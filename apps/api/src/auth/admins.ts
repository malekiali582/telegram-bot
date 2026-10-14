import { randomBytes } from 'node:crypto';
import type { Database, Executor } from '@lulu/database';
import { adminLoginAttempts, adminUsers, auditLogs, inTransaction } from '@lulu/database';
import { lockKey } from '@lulu/domain';
import { eq, isNull, sql } from 'drizzle-orm';
import type { AdminRole } from '../contract.ts';
import { checkNewPassword, hashPassword } from './password.ts';
import { revokeAdminSessions } from './sessions.ts';

export const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

export const normalizeUsername = (username: string) => username.trim().toLowerCase();

export type CreateAdminResult =
  | { status: 'ok'; adminUserId: number }
  | { status: 'invalid_username' }
  | { status: 'weak_password'; problem: 'too_short' | 'too_long' }
  | { status: 'username_taken' };

export async function createAdminUser(
  ex: Executor,
  input: { username: string; password: string; role: AdminRole; now: Date },
): Promise<CreateAdminResult> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) return { status: 'invalid_username' };
  const problem = checkNewPassword(input.password);
  if (problem) return { status: 'weak_password', problem };
  const [row] = await ex
    .insert(adminUsers)
    .values({
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: adminUsers.id });
  return row ? { status: 'ok', adminUserId: row.id } : { status: 'username_taken' };
}

export type InitialOwnerResult = CreateAdminResult | { status: 'admins_exist' };

/**
 * First-run account (`npm run admin:bootstrap`): creates an owner only while there is
 * no admin at all, so re-running it can never add a second way in.
 */
export async function createInitialOwner(
  db: Database,
  input: { username: string; password: string; now: Date },
): Promise<InitialOwnerResult> {
  return inTransaction(db, async (tx) => {
    await lockKey(tx, 'admin-users');
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(adminUsers);
    if (count > 0) return { status: 'admins_exist' as const };
    const result = await createAdminUser(tx, { ...input, role: 'owner' });
    if (result.status === 'ok') {
      await tx.insert(auditLogs).values({
        actor: 'system',
        action: 'admin.bootstrap',
        targetType: 'admin_user',
        targetId: String(result.adminUserId),
        details: { username: normalizeUsername(input.username), role: 'owner' },
        createdAt: input.now,
      });
    }
    return result;
  });
}

/** Sets a new password and ends all of that admin's sessions. */
export async function resetAdminPassword(
  db: Database,
  input: { adminUserId: number; password: string; now: Date },
): Promise<{ status: 'ok' } | { status: 'weak_password' } | { status: 'not_found' }> {
  if (checkNewPassword(input.password)) return { status: 'weak_password' };
  const passwordHash = await hashPassword(input.password);
  return inTransaction(db, async (tx) => {
    const updated = await tx
      .update(adminUsers)
      .set({ passwordHash })
      .where(eq(adminUsers.id, input.adminUserId))
      .returning({ id: adminUsers.id });
    if (updated.length === 0) return { status: 'not_found' as const };
    await revokeAdminSessions(tx, input.adminUserId, input.now);
    return { status: 'ok' as const };
  });
}

export async function activeOwners(ex: Executor): Promise<{ id: number; username: string }[]> {
  return ex
    .select({ id: adminUsers.id, username: adminUsers.username })
    .from(adminUsers)
    .where(sql`${adminUsers.role} = 'owner' AND ${isNull(adminUsers.disabledAt)}`)
    .orderBy(adminUsers.id);
}

export type ConsoleResetResult =
  | { status: 'ok'; username: string; password: string; reenabled: boolean }
  | { status: 'not_found'; usernames: string[] };

/**
 * Recovery on the server itself (`npm run admin:reset-password -- <username>`), for when
 * the only owner has lost the password: a new random password (shown once), every session
 * of that account ended, its failed-login counter cleared, and the account enabled again
 * if it was disabled. Recorded in the audit log as a system action.
 */
export async function resetPasswordFromConsole(
  db: Database,
  input: { username: string; now: Date },
): Promise<ConsoleResetResult> {
  const username = normalizeUsername(input.username);
  const password = randomBytes(15).toString('base64url');
  const passwordHash = await hashPassword(password);
  return inTransaction(db, async (tx) => {
    await lockKey(tx, 'admin-users');
    const [row] = await tx.select().from(adminUsers).where(eq(adminUsers.username, username));
    if (!row) {
      const all = await tx.select({ username: adminUsers.username }).from(adminUsers);
      return { status: 'not_found' as const, usernames: all.map((a) => a.username).sort() };
    }
    const reenabled = row.disabledAt !== null;
    await tx
      .update(adminUsers)
      .set({ passwordHash, disabledAt: null })
      .where(eq(adminUsers.id, row.id));
    await revokeAdminSessions(tx, row.id, input.now);
    await tx.delete(adminLoginAttempts).where(eq(adminLoginAttempts.username, username));
    await tx.insert(auditLogs).values({
      actor: 'system',
      action: 'admin.password_reset',
      targetType: 'admin_user',
      targetId: String(row.id),
      details: { username, source: 'console', reenabled },
      createdAt: input.now,
    });
    return { status: 'ok' as const, username, password, reenabled };
  });
}
