import { createTestGame } from '@lulu/domain/testing';
import type { TestGame } from '@lulu/domain/testing';
import { adminLoginAttempts, adminSessions, adminUsers, auditLogs } from '@lulu/database';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialOwner,
  createAdminUser,
  resetAdminPassword,
  resetPasswordFromConsole,
} from './admins.ts';
import { checkNewPassword, hashPassword, verifyPassword } from './password.ts';
import { createSession, findActiveSession } from './sessions.ts';

describe('password hashing', () => {
  it('verifies the right password only, with a fresh salt each time', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('treats malformed or absurd hashes as a mismatch, never a crash', async () => {
    for (const stored of ['', 'plain', 'scrypt$1$1$1$a$b', 'scrypt$9999999999$8$1$YQ$YQ']) {
      expect(await verifyPassword('x', stored)).toBe(false);
    }
  });

  it('wants at least 12 characters and bounds the length', () => {
    expect(checkNewPassword('short')).toBe('too_short');
    expect(checkNewPassword('۱۲۳۴۵۶۷۸۹۰۱۲')).toBeNull();
    expect(checkNewPassword('x'.repeat(257))).toBe('too_long');
  });
});

describe('admin accounts', () => {
  let game: TestGame;
  beforeEach(async () => {
    game = await createTestGame();
  });
  afterEach(async () => {
    await game.close();
  });

  it('creates the first owner only while no admin exists', async () => {
    const now = game.clock.now();
    const first = await createInitialOwner(game.ctx.db, {
      username: 'Malek',
      password: 'a long enough password',
      now,
    });
    expect(first.status).toBe('ok');
    const again = await createInitialOwner(game.ctx.db, {
      username: 'someone',
      password: 'a long enough password',
      now,
    });
    expect(again.status).toBe('admins_exist');
    const rows = await game.ctx.db.select().from(adminUsers);
    expect(rows).toEqual([expect.objectContaining({ username: 'malek', role: 'owner' })]);
    expect(rows[0]!.passwordHash).not.toContain('a long enough password');
    const audit = await game.ctx.db.select().from(auditLogs);
    expect(audit).toEqual([
      expect.objectContaining({ actor: 'system', action: 'admin.bootstrap' }),
    ]);
  });

  it('rejects bad usernames, weak passwords and duplicates', async () => {
    const now = game.clock.now();
    const create = (username: string, password = 'a long enough password') =>
      createAdminUser(game.ctx.db, { username, password, role: 'admin', now });
    expect((await create('ab')).status).toBe('invalid_username');
    expect((await create('علی')).status).toBe('invalid_username');
    expect((await create('helper', 'short')).status).toBe('weak_password');
    expect((await create('helper')).status).toBe('ok');
    expect((await create('HELPER')).status).toBe('username_taken');
  });

  it('ends every session when a password is reset', async () => {
    const now = game.clock.now();
    const created = await createAdminUser(game.ctx.db, {
      username: 'helper',
      password: 'a long enough password',
      role: 'admin',
      now,
    });
    if (created.status !== 'ok') throw new Error('setup');
    const session = await createSession(game.ctx.db, {
      adminUserId: created.adminUserId,
      secret: 's'.repeat(32),
      now,
      ttlMs: 12 * 3_600_000,
      ip: '127.0.0.1',
      userAgent: undefined,
    });
    expect(await findActiveSession(game.ctx.db, session.token, now, 30 * 60_000)).not.toBeNull();
    const reset = await resetAdminPassword(game.ctx.db, {
      adminUserId: created.adminUserId,
      password: 'another long password',
      now,
    });
    expect(reset.status).toBe('ok');
    expect(await findActiveSession(game.ctx.db, session.token, now, 30 * 60_000)).toBeNull();
    const [row] = await game.ctx.db.select().from(adminSessions);
    expect(row?.tokenHash).not.toBe(session.token);
  });
});

describe('password recovery on the server', () => {
  let game: TestGame;
  beforeEach(async () => {
    game = await createTestGame('2026-10-14T08:00:00Z');
  });
  afterEach(async () => {
    await game.close();
  });

  it('gives a locked-out, disabled owner a new password and clears the lockout', async () => {
    const now = game.clock.now();
    const created = await createAdminUser(game.ctx.db, {
      username: 'boss',
      password: 'the old long password',
      role: 'owner',
      now,
    });
    if (created.status !== 'ok') throw new Error(created.status);
    await game.ctx.db
      .update(adminUsers)
      .set({ disabledAt: now })
      .where(eq(adminUsers.id, created.adminUserId));
    await game.ctx.db
      .insert(adminLoginAttempts)
      .values(
        Array.from({ length: 6 }, () => ({ username: 'boss', ip: '1.2.3.4', succeeded: false })),
      );

    expect(await resetPasswordFromConsole(game.ctx.db, { username: 'nobody', now })).toEqual({
      status: 'not_found',
      usernames: ['boss'],
    });
    const reset = await resetPasswordFromConsole(game.ctx.db, { username: ' BOSS ', now });
    expect(reset).toMatchObject({ status: 'ok', username: 'boss', reenabled: true });
    if (reset.status !== 'ok') return;
    expect(reset.password.length).toBeGreaterThanOrEqual(20);

    const [row] = await game.ctx.db.select().from(adminUsers);
    expect(row!.disabledAt).toBeNull();
    expect(await verifyPassword(reset.password, row!.passwordHash)).toBe(true);
    expect(await game.ctx.db.select().from(adminLoginAttempts)).toEqual([]);
    const [audit] = await game.ctx.db.select().from(auditLogs);
    expect(audit).toMatchObject({
      actor: 'system',
      action: 'admin.password_reset',
      details: { username: 'boss', source: 'console', reenabled: true },
    });
  });
});
