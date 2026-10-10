/**
 * Acceptance 3 (spec §19.3): meal capacity, start and end times, and the automatic
 * deposits: every 5 minutes for 30 minutes, the food's fixed amount goes into cash,
 * without «لولو», exactly once each, however late it is settled.
 */
import { foodEffects } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import {
  claimLolo,
  eat,
  playerProfile,
  settleDuePlayers,
  treasuryView,
  upgradeLevel,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  cashOf,
  createTestGame,
  foodOf,
  giveFood,
  grantPoints,
  newGroup,
  newPlayer,
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
/** Cash in whole points, after settling (any player action settles first). */
const settledCash = async (userId: number) => {
  const v = await treasuryView(game.ctx, userId);
  if (v.status !== 'ok') throw new Error(v.status);
  return v.cashCenti / 100n;
};

/** Player at `level` with food, registered at T0. */
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
      pointsPerDeposit: 3,
      depositsTotal: 6,
      depositIntervalSeconds: 300,
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
    expect(meals.map((m) => [m.depositCenti, m.depositsTotal, m.depositsPaid])).toEqual([
      [15_000n, 6, 0],
      [15_000n, 6, 0],
    ]);
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

describe(`acceptance 3 — automatic food deposits (${testBackend()})`, () => {
  it('pays the owner amounts: 6 deposits per meal, in food order', async () => {
    const amounts = { bone: 3, mouse: 20, chicken: 70, pig: 150, sheep: 270, cow: 360, deer: 500 };
    for (const [food, perDeposit] of Object.entries(amounts)) {
      const userId = await player(5, { [food]: 1 });
      await eat(game.ctx, { userId, food: food as 'bone', count: 1 });
      at(1800);
      expect(await settledCash(userId), food).toBe(BigInt(perDeposit * 6));
    }
  });

  it('pays 1000 per deposit for a human meal', async () => {
    const userId = await player(6, { human: 1 });
    await eat(game.ctx, { userId, food: 'human', count: 1 });
    at(1800);
    expect(await settledCash(userId)).toBe(6_000n);
  });

  it('deposits at +5, +10 … +30 minutes, not before', async () => {
    const userId = await player(3, { mouse: 1 });
    await eat(game.ctx, { userId, food: 'mouse', count: 1 }); // 20 per deposit
    game.clock.set(new Date(T0 + 299_999));
    expect(await settledCash(userId)).toBe(0n);
    at(300);
    expect(await settledCash(userId)).toBe(20n);
    at(899);
    expect(await settledCash(userId)).toBe(40n);
    at(900);
    expect(await settledCash(userId)).toBe(60n);
    at(5000);
    expect(await settledCash(userId)).toBe(120n);
  });

  it('needs no «لولو»: the worker pays an idle player', async () => {
    const userId = await player(3, { mouse: 2 });
    await eat(game.ctx, { userId, food: 'mouse', count: 2 });
    at(600);
    await settleDuePlayers(game.ctx);
    expect(await cashOf(game, userId)).toBe(8_000n); // 2 meals × 2 deposits × 20 points
  });

  it('never pays a deposit twice, however often it is settled', async () => {
    const userId = await player(3, { mouse: 1 });
    await eat(game.ctx, { userId, food: 'mouse', count: 1 });
    for (const s of [300, 300, 301, 650, 650, 1200, 1800, 1800, 4000]) {
      at(s);
      await settleDuePlayers(game.ctx);
      await settledCash(userId);
    }
    expect(await cashOf(game, userId)).toBe(12_000n);
    const left = await game.ctx.db.select().from(foodEffects).where(eq(foodEffects.userId, userId));
    expect(left).toEqual([]); // fully paid meals are removed
  });

  it('pays lolo only its base reward; food never goes through lolo', async () => {
    const userId = await player(3, { mouse: 1 });
    await eat(game.ctx, { userId, food: 'mouse', count: 1 });
    at(300);
    const result = await claimLolo(game.ctx, { userId, groupId: group });
    // the deposit due at +5 min is settled first; lolo adds just its base (50 at level 3)
    expect(result).toMatchObject({ status: 'ok', basePoints: 50, cashCenti: 7_000n });
  });

  it('pays every meal of a multi-meal request', async () => {
    const userId = await player(4, { chicken: 3 });
    await eat(game.ctx, { userId, food: 'chicken', count: 3 });
    at(1800);
    expect(await settledCash(userId)).toBe(3n * 70n * 6n);
  });

  it('keeps running meals and their timing across a level upgrade', async () => {
    const userId = await player(2, { bone: 1 });
    await eat(game.ctx, { userId, food: 'bone', count: 1 });
    await grantPoints(game, userId, 6_000);
    at(100);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 2 })).toMatchObject({
      status: 'ok',
    });
    at(1800);
    expect(await settledCash(userId)).toBe(18n);
  });

  it('shows running meals with the deposits still to come', async () => {
    const userId = await player(3, { mouse: 1 });
    await eat(game.ctx, { userId, food: 'mouse', count: 1 });
    at(700);
    const profile = await playerProfile(game.ctx, userId);
    expect(profile.meals.active).toEqual([
      { food: 'mouse', expiresAt: new Date(T0 + 1_800_000), depositCenti: 2_000n, depositsLeft: 4 },
    ]);
  });
});
