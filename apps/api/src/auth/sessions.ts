import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Executor } from '@lulu/database';
import { adminSessions, adminUsers } from '@lulu/database';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type { AdminRole } from '../contract.ts';

/**
 * Admin sessions. The random token lives only in the HttpOnly cookie; the database
 * keeps its SHA-256. A session ends after 30 minutes without a request, 12 hours after
 * login, on logout, or when its admin is disabled.
 *
 * The CSRF token is derived from the session token with SESSION_SECRET (HMAC), so the
 * panel can fetch it again after a page reload; the database keeps its hash too.
 */

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 12 * 60 * 60_000;
/** `last_seen_at` is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60_000;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function csrfTokenFor(secret: string, sessionToken: string): string {
  return createHmac('sha256', secret).update(`csrf\0${sessionToken}`).digest('base64url');
}

/** Constant-time string comparison through fixed-length digests. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  ex: Executor,
  input: {
    adminUserId: number;
    secret: string;
    now: Date;
    ip: string;
    userAgent: string | undefined;
  },
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = csrfTokenFor(input.secret, token);
  const expiresAt = new Date(input.now.getTime() + SESSION_MAX_MS);
  await ex.insert(adminSessions).values({
    tokenHash: sha256(token),
    adminUserId: input.adminUserId,
    csrfTokenHash: sha256(csrfToken),
    createdAt: input.now,
    lastSeenAt: input.now,
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  });
  return { token, csrfToken, expiresAt };
}

export interface ActiveSession {
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  admin: { id: number; username: string; role: AdminRole };
}

/** The live session for a cookie token, or null. Refreshes its idle timer. */
export async function findActiveSession(
  ex: Executor,
  token: string,
  now: Date,
): Promise<ActiveSession | null> {
  if (token.length < 20 || token.length > 100) return null;
  const tokenHash = sha256(token);
  const [row] = await ex
    .select({
      tokenHash: adminSessions.tokenHash,
      csrfTokenHash: adminSessions.csrfTokenHash,
      expiresAt: adminSessions.expiresAt,
      lastSeenAt: adminSessions.lastSeenAt,
      revokedAt: adminSessions.revokedAt,
      adminId: adminUsers.id,
      username: adminUsers.username,
      role: adminUsers.role,
      disabledAt: adminUsers.disabledAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .where(eq(adminSessions.tokenHash, tokenHash));
  if (!row || row.revokedAt !== null || row.disabledAt !== null) return null;
  const t = now.getTime();
  if (t >= row.expiresAt.getTime() || t - row.lastSeenAt.getTime() >= SESSION_IDLE_MS) return null;

  if (t - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    await ex
      .update(adminSessions)
      .set({ lastSeenAt: now })
      .where(eq(adminSessions.tokenHash, tokenHash));
  }
  return {
    tokenHash,
    csrfTokenHash: row.csrfTokenHash,
    expiresAt: row.expiresAt,
    admin: { id: row.adminId, username: row.username, role: row.role },
  };
}

export async function revokeSession(ex: Executor, tokenHash: string, now: Date): Promise<void> {
  await ex
    .update(adminSessions)
    .set({ revokedAt: now })
    .where(and(eq(adminSessions.tokenHash, tokenHash), isNull(adminSessions.revokedAt)));
}

/** Ends every session of an admin except `keepTokenHash` (password change, role change). */
export async function revokeAdminSessions(
  ex: Executor,
  adminUserId: number,
  now: Date,
  keepTokenHash?: string,
): Promise<void> {
  await ex
    .update(adminSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(adminSessions.adminUserId, adminUserId),
        isNull(adminSessions.revokedAt),
        keepTokenHash === undefined ? undefined : ne(adminSessions.tokenHash, keepTokenHash),
      ),
    );
}

/** Drops sessions that ended more than a week ago; they are useless and hold IPs. */
export async function pruneSessions(ex: Executor, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  await ex
    .delete(adminSessions)
    .where(or(lt(adminSessions.expiresAt, cutoff), lt(adminSessions.revokedAt, cutoff)));
}
