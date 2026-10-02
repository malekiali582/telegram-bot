import { auditLogs, ledgerEntries, playerState, transactions } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adjustBalance, setPlayerBan } from './admin.ts';
import { claimLolo } from './lolo.ts';
import { playerFearRank, scaryLeaderboard } from './leaderboard.ts';
import type { TestGame } from './testing.ts';
import {
  cashOf,
  createAdminUser,
  createTestGame,
  grantPoints,
  newGroup,
  newPlayer,
  setLevel,
  tehranTime,
  treasuryOf,
} from './testing.ts';
import { depositToTreasury } from './treasury.ts';

let game: TestGame;
let adminId: number;
beforeAll(async () => {
  game = await createTestGame();
  adminId = await createAdminUser(game);
});
afterAll(async () => {
  await game.close();
});

describe(`«ترسناک‌ترین لولوها» (${testBackend()})`, () => {
  it('ranks by fear, then level, then stable user id; excludes banned; scopes by group', async () => {
    const isolated = await createTestGame();
    try {
      const g = isolated.ctx;
      const [a, b, c, d, banned] = [
        await newPlayer(isolated, 'a'),
        await newPlayer(isolated, 'b'),
        await newPlayer(isolated, 'c'),
        await newPlayer(isolated, 'd'),
        await newPlayer(isolated, 'banned'),
      ];
      const fear = (u: number, f: number) =>
        g.db.update(playerState).set({ fear: f }).where(eq(playerState.userId, u));
      await fear(a, 50);
      await fear(b, 80);
      await fear(c, 50);
      await fear(d, 50);
      await fear(banned, 999);
      await setLevel(isolated, c, 3);
      const admin = await createAdminUser(isolated);
      await setPlayerBan(g, { userId: banned, banned: true, reason: 'تقلب', adminUserId: admin });

      const global = await scaryLeaderboard(g, { limit: 10 });
      // b (80) · c (50, level 3) · a (50, lower id) · d (50)
      expect(global.map((e) => [e.rank, e.displayName, e.fear])).toEqual([
        [1, 'b', 80],
        [2, 'c', 50],
        [3, 'a', 50],
        [4, 'd', 50],
      ]);

      const group = await newGroup(isolated);
      await claimLolo(g, { userId: a, groupId: group });
      await claimLolo(g, { userId: d, groupId: group });
      expect((await scaryLeaderboard(g, { groupId: group })).map((e) => e.displayName)).toEqual([
        'a',
        'd',
      ]);
      expect(await playerFearRank(g, { userId: d, groupId: group })).toMatchObject({
        rank: 2,
        fear: 50,
      });
      expect(await playerFearRank(g, { userId: d })).toMatchObject({ rank: 4 }); // same fear globally
      expect(await playerFearRank(g, { userId: banned })).toBeNull();
    } finally {
      await isolated.close();
    }
  });
});

describe(`admin actions (${testBackend()})`, () => {
  it('bans and unbans with a required reason and an audit entry; banned players cannot act', async () => {
    const userId = await newPlayer(game);
    const group = await newGroup(game);
    expect(
      await setPlayerBan(game.ctx, { userId, banned: true, reason: '  ', adminUserId: adminId }),
    ).toEqual({
      status: 'reason_required',
    });
    expect(
      await setPlayerBan(game.ctx, { userId, banned: true, reason: 'اسپم', adminUserId: adminId }),
    ).toEqual({
      status: 'ok',
    });
    expect(
      await setPlayerBan(game.ctx, { userId, banned: true, reason: 'باز', adminUserId: adminId }),
    ).toEqual({
      status: 'unchanged',
    });
    expect(await claimLolo(game.ctx, { userId, groupId: group })).toEqual({ status: 'banned' });
    expect(
      await setPlayerBan(game.ctx, { userId, banned: false, reason: 'رفع', adminUserId: adminId }),
    ).toEqual({
      status: 'ok',
    });
    expect((await claimLolo(game.ctx, { userId, groupId: group })).status).toBe('ok');
    const logs = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, String(userId)));
    expect(logs.map((l) => [l.action, l.reason])).toEqual([
      ['player.ban', 'اسپم'],
      ['player.unban', 'رفع'],
    ]);
  });

  it('corrects balances only with a compensating, reasoned, audited transaction', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 100);
    const [before] = await game.ctx.db
      .select()
      .from(ledgerEntries)
      .orderBy(desc(ledgerEntries.id))
      .limit(1);

    expect(
      await adjustBalance(game.ctx, {
        userId,
        wallet: 'cash',
        amountCenti: -5_000n,
        reason: '',
        adminUserId: adminId,
      }),
    ).toEqual({ status: 'reason_required' });
    expect(
      await adjustBalance(game.ctx, {
        userId,
        wallet: 'cash',
        amountCenti: -10_001n,
        reason: 'خطا',
        adminUserId: adminId,
      }),
    ).toEqual({ status: 'insufficient_funds', balanceCenti: 10_000n });
    const ok = await adjustBalance(game.ctx, {
      userId,
      wallet: 'cash',
      amountCenti: -2_500n,
      reason: 'جبران باگ',
      adminUserId: adminId,
      idempotencyKey: 'adj-1',
    });
    expect(ok).toMatchObject({ status: 'ok', balanceCenti: 7_500n });
    expect(
      await adjustBalance(game.ctx, {
        userId,
        wallet: 'cash',
        amountCenti: -2_500n,
        reason: 'جبران باگ',
        adminUserId: adminId,
        idempotencyKey: 'adj-1',
      }),
    ).toEqual({ status: 'duplicate' });
    expect(await cashOf(game, userId)).toBe(7_500n);

    if (ok.status !== 'ok') throw new Error('expected ok');
    const [tx] = await game.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, ok.transactionId));
    expect(tx).toMatchObject({
      kind: 'admin_adjustment',
      reason: 'جبران باگ',
      adminUserId: adminId,
    });
    // earlier ledger rows are untouched (append-only)
    const [again] = await game.ctx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, before!.id));
    expect(again).toEqual(before);
  });

  it('settles past midnights before a treasury correction', async () => {
    game.clock.set(tehranTime('2026-10-02', '12:00:00'));
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 1000);
    await depositToTreasury(game.ctx, { userId, amountCenti: 100_000n });
    game.clock.set(tehranTime('2026-10-03', '09:00:00'));
    await adjustBalance(game.ctx, {
      userId,
      wallet: 'treasury',
      amountCenti: 1_000n,
      reason: 'هدیه',
      adminUserId: adminId,
    });
    expect(await treasuryOf(game, userId)).toBe(103_000n + 1_000n);
  });
});
