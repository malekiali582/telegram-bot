/**
 * Acceptance 3 (spec §19.3): meal capacity, start and end times, partial use of the
 * window, the 300 s cap, a meal that just expired, and no double claim.
 */
import { foodEffects } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { claimLolo, eat, upgradeLevel } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  createTestGame,
  foodOf,
  giveFood,
  grantPoints,
  newGroup,
  newPlayer,
  setCurseLevel,
  setLevel,
} from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let group: number;
const T0 = Date.parse(TEST_START);

beforeAll(async () => {
  game = await createTestGame();
  group = await newGroup(game);
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
  game.rng.fallback = 'min';
});

const at = (seconds: number) => game.clock.set(new Date(T0 + seconds * 1000));
const lolo = (userId: number, groupId = group) => claimLolo(game.ctx, { userId, groupId });
const bonusOf = async (userId: number, groupId = group) => {
  const result = await lolo(userId, groupId);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.foodBonusPoints;
};

/** Player at `level` with food, registered at T0 and with a first lolo at T0. */
async function player(level: number, food: Record<string, number> = { bone: 10, mouse: 10 }) {
  at(0);
  const userId = await newPlayer(game);
  await setLevel(game, userId, level);
  for (const [kind, qty] of Object.entries(food)) {
    await giveFood(game, userId, kind as 'bone', qty);
  }
  return userId;
}

describe(`acceptance 3 — meal capacity (${testBackend()})`, () => {
  it('level 1 cannot eat at all (capacity 0)', async () => {
    const userId = await player(1);
    expect(await eat(game.ctx, { userId, food: 'bone', count: 1 })).toEqual({
      status: 'capacity_exceeded',
      active: 0,
      capacity: 0,
      requested: 1,
    });
    expect(await foodOf(game, userId, 'bone')).toBe(10);
  });

  it('rejects a request over capacity entirely and never replaces a running meal', async () => {
    const userId = await player(2); // capacity 1
    expect(await eat(game.ctx, { userId, food: 'bone', count: 2 })).toMatchObject({
      status: 'capacity_exceeded',
      requested: 2,
    });
    expect(await foodOf(game, userId, 'bone')).toBe(10);
    expect(await eat(game.ctx, { userId, food: 'bone', count: 1 })).toMatchObject({ status: 'ok' });
    expect(await eat(game.ctx, { userId, food: 'mouse', count: 1 })).toMatchObject({
      status: 'capacity_exceeded',
      active: 1,
    });
  });

  it('starts a meal now and frees its slot exactly 1800 s later', async () => {
    const userId = await player(2);
    expect(await eat(game.ctx, { userId, food: 'bone', count: 1 })).toMatchObject({
      status: 'ok',
      startedAt: new Date(T0),
      expiresAt: new Date(T0 + 1_800_000),
    });
    game.clock.set(new Date(T0 + 1_799_999));
    expect(await eat(game.ctx, { userId, food: 'bone', count: 1 })).toMatchObject({
      status: 'capacity_exceeded',
    });
    at(1800);
    expect(await eat(game.ctx, { userId, food: 'bone', count: 1 })).toMatchObject({ status: 'ok' });
  });

  it('requires the food in the cellar and takes exactly what was eaten', async () => {
    const userId = await player(4, { pig: 2 }); // capacity 15
    expect(await eat(game.ctx, { userId, food: 'pig', count: 3 })).toEqual({
      status: 'not_enough_food',
      food: 'pig',
      have: 2,
      requested: 3,
    });
    expect(await eat(game.ctx, { userId, food: 'pig', count: 2 })).toMatchObject({
      status: 'ok',
      activeMeals: 2,
    });
    expect(await foodOf(game, userId, 'pig')).toBe(0);
    const meals = await game.ctx.db
      .select()
      .from(foodEffects)
      .where(eq(foodEffects.userId, userId));
    expect(meals.map((m) => m.pointsPerSecond)).toEqual([45, 45]); // 5 × nutrition 9
  });

  it('lets only one of two concurrent meals into the last slot', async () => {
    const userId = await player(2, { bone: 2 });
    const results = await Promise.all([
      eat(game.ctx, { userId, food: 'bone', count: 1 }),
      eat(game.ctx, { userId, food: 'bone', count: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['capacity_exceeded', 'ok']);
    expect(await foodOf(game, userId, 'bone')).toBe(1);
  });

  it('dedupes a repeated eat request', async () => {
    const userId = await player(3);
    await eat(game.ctx, { userId, food: 'bone', count: 1, idempotencyKey: 'eat:1' });
    expect(
      await eat(game.ctx, { userId, food: 'bone', count: 1, idempotencyKey: 'eat:1' }),
    ).toEqual({ status: 'duplicate' });
    expect(await foodOf(game, userId, 'bone')).toBe(9);
  });
});

describe(`acceptance 3 — food bonus on lolo (${testBackend()})`, () => {
  it('spec example: a bone active for the whole window adds 1500', async () => {
    const userId = await player(3);
    await lolo(userId); // T0
    await eat(game.ctx, { userId, food: 'bone', count: 1 }); // T0
    at(300);
    expect(await bonusOf(userId)).toBe(1500n);
  });

  it('spec example: a mouse eaten 120 s before the lolo adds 1200', async () => {
    const userId = await player(3);
    await lolo(userId);
    at(180);
    await eat(game.ctx, { userId, food: 'mouse', count: 1 });
    at(300);
    expect(await bonusOf(userId)).toBe(1200n);
  });

  it('caps the window at 300 s however long since the last lolo', async () => {
    const userId = await player(3);
    await lolo(userId);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    at(1000);
    expect(await bonusOf(userId)).toBe(1500n);
  });

  it('spec example: no bonus from a meal that expired before the last 5 minutes', async () => {
    const userId = await player(3);
    await lolo(userId);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    at(2400); // 40 minutes without lolo; the meal ended at 30 minutes
    expect(await bonusOf(userId)).toBe(0n);
  });

  it('counts a meal that expired one minute ago for the 4 minutes it covered', async () => {
    const userId = await player(3);
    await lolo(userId);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    at(1500);
    expect(await bonusOf(userId)).toBe(1500n);
    at(1860); // meal ended at 1800; window [1560, 1860)
    expect(await bonusOf(userId)).toBe(1200n);
  });

  it('never pays the same seconds twice, and a lolo during cooldown consumes nothing', async () => {
    const userId = await player(3);
    await lolo(userId);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    at(100);
    expect(await lolo(userId)).toMatchObject({ status: 'cooldown' });
    at(300);
    expect(await bonusOf(userId)).toBe(1500n);
    at(600);
    expect(await bonusOf(userId)).toBe(1500n);
    // total over 600 s of one bone is exactly 600 × 5
  });

  it('uses the account start before the first successful lolo', async () => {
    const userId = await player(3);
    await eat(game.ctx, { userId, food: 'bone', count: 1 }); // T0, account start
    at(120);
    expect(await bonusOf(userId)).toBe(600n);
  });

  it('a shorter cooldown from a buff does not enlarge the window', async () => {
    const buffed = await newGroup(game, 'پژواک');
    await setCurseLevel(game, buffed, 'lolo_echo', 4); // 240 s
    const userId = await player(3);
    await lolo(userId, buffed);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    at(240);
    expect(await bonusOf(userId, buffed)).toBe(1200n);
  });

  it('with a buffed 240 s cooldown, seconds already paid are never paid again', async () => {
    const buffed = await newGroup(game, 'پژواک ۲');
    await setCurseLevel(game, buffed, 'lolo_echo', 4);
    const userId = await player(3);
    await eat(game.ctx, { userId, food: 'bone', count: 1 }); // T0
    at(100);
    expect(await bonusOf(userId, buffed)).toBe(500n); // [T0, T0+100)
    at(340);
    // window is [T0+100, T0+340): 240 s, not the 300 s that would re-pay [T0+40, T0+100)
    expect(await bonusOf(userId, buffed)).toBe(1200n);
  });

  it('keeps running meals and their timing across a level upgrade', async () => {
    const userId = await player(2);
    await lolo(userId);
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    await grantPoints(game, userId, 6_000);
    at(100);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 2 })).toMatchObject({
      status: 'ok',
    });
    at(300);
    expect(await bonusOf(userId)).toBe(1500n);
  });

  it('adds several meals, rounding only the total down', async () => {
    const userId = await player(3);
    await lolo(userId);
    game.clock.set(new Date(T0 + 199_900));
    await eat(game.ctx, { userId, food: 'bone', count: 2 }); // each overlaps 100.1 s
    at(300);
    expect(await bonusOf(userId)).toBe(1001n);
  });
});
