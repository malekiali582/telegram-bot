/**
 * Acceptance 6 (spec §19.6): offline cemetery income, settlement after a restart, an
 * upgrade mid-period, and the exact 105 points for two hours at level 1.
 */
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { cemeteries, configVersions } from '@lulu/database';
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import {
  ConfigProvider,
  cemeteryView,
  createDomainContext,
  openCemetery,
  settleDuePlayers,
  upgradeCemetery,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { TEST_START, cashOf, createTestGame, grantPoints, newPlayer } from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
const T0 = Date.parse(TEST_START);
const HOUR = 3_600_000;

beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
});

const at = (ms: number) => game.clock.set(new Date(T0 + ms));
const look = async (userId: number) => {
  const v = await cemeteryView(game.ctx, userId);
  return v;
};

/** Player with an open cemetery at `level`, all costs paid, cash 0 at T0. */
async function graveyard(level = 0) {
  const userId = await newPlayer(game);
  const costs = DEFAULT_GAME_CONFIG.cemetery.upgradeCosts
    .slice(0, level)
    .reduce((a, c) => a + c, 0);
  await grantPoints(game, userId, 1000 + costs);
  expect((await openCemetery(game.ctx, { userId })).status).toBe('ok');
  for (let l = 0; l < level; l++) {
    expect((await upgradeCemetery(game.ctx, { userId, expectedLevel: l })).status).toBe('ok');
  }
  expect(await cashOf(game, userId)).toBe(0n);
  return userId;
}

describe(`acceptance 6 — cemetery income (${testBackend()})`, () => {
  it('opens for exactly 1000 and refuses without enough cash', async () => {
    const poor = await newPlayer(game);
    await grantPoints(game, poor, 999);
    expect(await openCemetery(game.ctx, { userId: poor })).toEqual({
      status: 'insufficient_funds',
      costCenti: 100_000n,
      cashCenti: 99_900n,
    });
    const userId = await graveyard();
    expect(await look(userId)).toMatchObject({
      status: 'open',
      level: 0,
      hourlyIncomeCenti: 5_000n,
    });
    expect(await openCemetery(game.ctx, { userId })).toEqual({ status: 'already_open' });
  });

  it('pays while the player is offline, with no collect button', async () => {
    const userId = await graveyard(0);
    at(3 * HOUR); // nothing happened for three hours
    await look(userId);
    expect(await cashOf(game, userId)).toBe(15_000n); // 3 × 50
  });

  it('spec example: level 1 for two hours pays exactly 105', async () => {
    const userId = await graveyard(1);
    expect(await look(userId)).toMatchObject({ level: 1, hourlyIncomeCenti: 5_250n });
    at(2 * HOUR);
    await look(userId);
    expect(await cashOf(game, userId)).toBe(10_500n);
  });

  it('keeps fractions: settling every 37 s for two hours still totals exactly 105', async () => {
    const userId = await graveyard(1);
    // 37 s at 52.5/h is 53.958… centi per tick: rounding each tick would lose money
    for (let ms = 37_000; ms <= 2 * HOUR; ms += 37_000) {
      at(ms);
      await look(userId);
    }
    at(2 * HOUR);
    await look(userId);
    expect(await cashOf(game, userId)).toBe(10_500n);
  });

  it('settles at the old rate up to an upgrade, then uses the new one', async () => {
    const userId = await graveyard(0);
    await grantPoints(game, userId, 500);
    at(HOUR);
    expect(await upgradeCemetery(game.ctx, { userId, expectedLevel: 0 })).toMatchObject({
      status: 'ok',
      newLevel: 1,
    });
    // 1 h × 50 = 50 credited before the 500 upgrade cost was taken
    expect(await cashOf(game, userId)).toBe(5_000n);
    at(2 * HOUR);
    await look(userId);
    expect(await cashOf(game, userId)).toBe(5_000n + 5_250n); // + 1 h × 52.5
  });

  it('caps at level 3 (57.5/h) and rejects stale or unaffordable upgrades', async () => {
    const userId = await graveyard(3);
    expect(await look(userId)).toMatchObject({
      level: 3,
      hourlyIncomeCenti: 5_750n,
      nextUpgradeCostCenti: null,
    });
    expect(await upgradeCemetery(game.ctx, { userId, expectedLevel: 3 })).toEqual({
      status: 'max_level',
      currentLevel: 3,
    });
    const other = await graveyard(0);
    expect(await upgradeCemetery(game.ctx, { userId: other, expectedLevel: 1 })).toEqual({
      status: 'stale',
      currentLevel: 0,
    });
    expect(await upgradeCemetery(game.ctx, { userId: other, expectedLevel: 0 })).toMatchObject({
      status: 'insufficient_funds',
      costCenti: 50_000n,
    });
  });

  it('after a server restart, pays the downtime once and only once', async () => {
    const userId = await graveyard(2);
    at(72 * HOUR); // three days down
    const restarted = createDomainContext(game.ctx.db, {
      clock: game.clock,
      rng: game.rng,
      config: new ConfigProvider(),
    });
    await cemeteryView(restarted, userId);
    await settleDuePlayers(restarted);
    await cemeteryView(game.ctx, userId);
    expect(await cashOf(game, userId)).toBe(72n * 5_500n);
  });

  it('applies a later rate change only from its effective time', async () => {
    // own database: config versions are permanent history and must not leak into other tests
    const isolated = await createTestGame();
    try {
      const userId = await newPlayer(isolated);
      await grantPoints(isolated, userId, 1000);
      await openCemetery(isolated.ctx, { userId });
      const changed = structuredClone(DEFAULT_GAME_CONFIG);
      changed.cemetery.baseHourlyIncome = 100;
      await isolated.ctx.db.insert(configVersions).values({
        config: changed,
        source: 'panel',
        effectiveFrom: new Date(T0 + HOUR),
      });
      isolated.clock.set(new Date(T0 + 2 * HOUR));
      await cemeteryView(isolated.ctx, userId);
      expect(await cashOf(isolated, userId)).toBe(5_000n + 10_000n); // 1 h × 50 + 1 h × 100
    } finally {
      await isolated.close();
    }
  });

  it('stores the leftover fraction instead of dropping it', async () => {
    const userId = await graveyard(1);
    at(1_000); // 1 s at 52.5/h = 1.458… centi
    await look(userId);
    const [row] = await game.ctx.db.select().from(cemeteries).where(eq(cemeteries.userId, userId));
    expect(await cashOf(game, userId)).toBe(1n);
    expect(row?.accrualRemainder).toBeGreaterThan(0n);
  });
});

describe.runIf(usingRealPostgres)('acceptance 6 — concurrent settlement on real PostgreSQL', () => {
  it('jobs and player reads racing each other pay the period exactly once', async () => {
    const userId = await graveyard(1);
    at(4 * HOUR);
    await Promise.all([
      settleDuePlayers(game.ctx),
      cemeteryView(game.ctx, userId),
      settleDuePlayers(game.ctx),
      cemeteryView(game.ctx, userId),
      cemeteryView(game.ctx, userId),
    ]);
    expect(await cashOf(game, userId)).toBe(4n * 5_250n);
  });
});
