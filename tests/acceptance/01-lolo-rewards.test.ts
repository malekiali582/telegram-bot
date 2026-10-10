/**
 * Acceptance 1 (spec §19.1): min/max reward of all six levels, the global cooldown,
 * and a simultaneous «لولو» in two groups.
 */
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { playerState, transactions } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { claimLolo, upgradeLevel } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  banPlayer,
  cashOf,
  createTestGame,
  grantPoints,
  newGroup,
  newPlayer,
  setCurseLevel,
  setLevel,
} from '@lulu/domain/testing';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let groupA: number;
let groupB: number;

beforeAll(async () => {
  game = await createTestGame();
  groupA = await newGroup(game, 'الف');
  groupB = await newGroup(game, 'ب');
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
  game.rng.fallback = 'min';
});

const lolo = (userId: number, groupId = groupA) => claimLolo(game.ctx, { userId, groupId });

describe(`acceptance 1 — lolo rewards and global cooldown (${testBackend()})`, () => {
  it.each(DEFAULT_GAME_CONFIG.levels.map((l) => [l.level, l.rewardMin, l.rewardMax] as const))(
    'level %i pays between %i and %i inclusive',
    async (level, min, max) => {
      for (const [fallback, expected] of [
        ['min', min],
        ['max', max],
      ] as const) {
        const userId = await newPlayer(game);
        await setLevel(game, userId, level);
        game.rng.fallback = fallback;
        const before = game.rng.calls.length;
        const result = await lolo(userId);
        expect(result).toMatchObject({ status: 'ok', basePoints: expected });
        // the random draw is over exactly the closed range of the level
        expect(game.rng.calls.slice(before)).toEqual([[min, max]]);
        expect(await cashOf(game, userId)).toBe(BigInt(expected) * 100n);
      }
    },
  );

  it('shares one 300 s cooldown across groups; it ends exactly at 300 s', async () => {
    const userId = await newPlayer(game);
    expect(await lolo(userId, groupA)).toMatchObject({ status: 'ok', basePoints: 1 });

    expect(await lolo(userId, groupB)).toMatchObject({ status: 'cooldown', remainingMs: 300_000 });
    game.clock.advance(299_999);
    expect(await lolo(userId, groupB)).toMatchObject({ status: 'cooldown', remainingMs: 1 });
    game.clock.advance(1);
    expect(await lolo(userId, groupB)).toMatchObject({ status: 'ok' });
    expect(await cashOf(game, userId)).toBe(200n);
  });

  it('pays only once for «لولو» sent at the same moment in two groups', async () => {
    const userId = await newPlayer(game);
    const results = await Promise.all([lolo(userId, groupA), lolo(userId, groupB)]);
    expect(results.map((r) => r.status).sort()).toEqual(['cooldown', 'ok']);
    expect(await cashOf(game, userId)).toBe(100n);
  });

  it('pays only once for 10 concurrent repeats', async () => {
    const userId = await newPlayer(game);
    const results = await Promise.all(Array.from({ length: 10 }, () => lolo(userId)));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(await cashOf(game, userId)).toBe(100n);
    const [row] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(row?.n).toBe(1);
  });

  it('a lolo during the cooldown changes neither balance nor last-lolo time', async () => {
    const userId = await newPlayer(game);
    await lolo(userId);
    const [before] = await game.ctx.db
      .select({ lastLoloAt: playerState.lastLoloAt })
      .from(playerState)
      .where(eq(playerState.userId, userId));
    game.clock.advance(120_000);
    expect(await lolo(userId)).toMatchObject({ status: 'cooldown' });
    const [after] = await game.ctx.db
      .select({ lastLoloAt: playerState.lastLoloAt })
      .from(playerState)
      .where(eq(playerState.userId, userId));
    expect(after?.lastLoloAt).toEqual(before?.lastLoloAt);
    expect(await cashOf(game, userId)).toBe(100n);
  });

  it('rate-limits "time remaining" replies per group (60 s)', async () => {
    const userId = await newPlayer(game);
    await lolo(userId, groupA);
    expect(await lolo(userId, groupA)).toMatchObject({ status: 'cooldown', notify: true });
    expect(await lolo(userId, groupA)).toMatchObject({ status: 'cooldown', notify: false });
    expect(await lolo(userId, groupB)).toMatchObject({ status: 'cooldown', notify: true });
    game.clock.advance(59_999);
    expect(await lolo(userId, groupA)).toMatchObject({ notify: false });
    game.clock.advance(1);
    expect(await lolo(userId, groupA)).toMatchObject({ notify: true });
  });

  it('records the cooldown with the buff of the group it was earned in', async () => {
    const buffed = await newGroup(game, 'پژواک');
    await setCurseLevel(game, buffed, 'lolo_echo', 4); // 300 s → 240 s

    const fast = await newPlayer(game);
    expect(await lolo(fast, buffed)).toMatchObject({
      status: 'ok',
      nextAvailableAt: new Date(Date.parse(TEST_START) + 240_000),
    });
    game.clock.advanceSeconds(240);
    // the snapshot holds even when the next lolo is in an unbuffed group
    expect(await lolo(fast, groupA)).toMatchObject({ status: 'ok' });

    game.clock.set(TEST_START);
    const slow = await newPlayer(game);
    await lolo(slow, groupA);
    game.clock.advanceSeconds(240);
    // a buff elsewhere never shortens an already recorded wait
    expect(await lolo(slow, buffed)).toMatchObject({ status: 'cooldown', remainingMs: 60_000 });
  });

  it('a level upgrade does not reset the cooldown', async () => {
    const userId = await newPlayer(game);
    await lolo(userId);
    await grantPoints(game, userId, 300);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 1 })).toMatchObject({
      status: 'ok',
      newLevel: 2,
    });
    game.clock.advanceSeconds(10);
    expect(await lolo(userId)).toMatchObject({ status: 'cooldown', remainingMs: 290_000 });
  });

  it('a banned player gets nothing', async () => {
    const userId = await newPlayer(game);
    await banPlayer(game, userId);
    expect(await lolo(userId)).toEqual({ status: 'banned' });
    expect(await cashOf(game, userId)).toBe(0n);
  });
});
