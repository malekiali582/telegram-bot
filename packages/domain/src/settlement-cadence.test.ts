import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { configVersions, queryRows } from '@lulu/database';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openCemetery } from './cemetery.ts';
import { economyOverview } from './dashboard.ts';
import { eat } from './food.ts';
import { scaryLeaderboard } from './leaderboard.ts';
import { claimLolo } from './lolo.ts';
import { settleDuePlayers } from './settlement-job.ts';
import type { TestGame } from './testing.ts';
import {
  cashOf,
  createTestGame,
  giveFood,
  grantPoints,
  newGroup,
  newPlayer,
  setLevel,
  treasuryOf,
} from './testing.ts';
import { depositToTreasury } from './treasury.ts';

/**
 * The worker settles idle accounts hourly instead of every minute (owner's choice,
 * 2026-10-12). Settlement credits by elapsed time and counts deposits, so how often it
 * runs must never change any amount: here the same game is settled every minute, every
 * hour and only once, across a Tehran midnight and a change of the cemetery rate.
 */

const START = '2026-10-12T19:00:00Z'; // 22:30 Tehran; midnight comes at minute 90
const MINUTES = 240;
const games: TestGame[] = [];
afterEach(async () => {
  while (games.length) await games.pop()!.close();
});

async function settleAll(game: TestGame): Promise<void> {
  let afterUserId: number | undefined;
  for (;;) {
    const batch = await settleDuePlayers(game.ctx, {
      ...(afterUserId ? { afterUserId } : {}),
      limit: 50,
    });
    if (batch.settled < 50 || batch.lastUserId === undefined) return;
    afterUserId = batch.lastUserId;
  }
}

/** Plays the same four hours; the worker settles every `step` minutes. */
async function play(step: number) {
  const game = await createTestGame(START);
  games.push(game);
  const at = (minute: number) =>
    game.clock.set(new Date(new Date(START).getTime() + minute * 60_000));

  const eater = await newPlayer(game, 'خورنده');
  const idle = await newPlayer(game, 'بی‌کار');
  const streaker = await newPlayer(game, 'استریکی');
  const group = await newGroup(game);
  for (const p of [eater, idle]) {
    await grantPoints(game, p, 5_000);
    expect((await openCemetery(game.ctx, { userId: p })).status).toBe('ok');
  }
  await depositToTreasury(game.ctx, { userId: idle, amountCenti: 200_000n }); // 2 000 points
  await setLevel(game, eater, 4);
  await giveFood(game, eater, 'chicken', 5);
  expect((await eat(game.ctx, { userId: eater, food: 'chicken', count: 3 })).status).toBe('ok');
  await claimLolo(game.ctx, { userId: streaker, groupId: group });

  for (let minute = 1; minute <= MINUTES; minute++) {
    at(minute);
    if (minute === 75) {
      // A meal eaten at 23:45 pays its deposits across midnight.
      expect((await eat(game.ctx, { userId: eater, food: 'chicken', count: 2 })).status).toBe('ok');
    }
    if (minute === 100) {
      // The cemetery rate changes in the panel while income is unsettled.
      const config = structuredClone(DEFAULT_GAME_CONFIG);
      config.cemetery.baseHourlyIncome = 80;
      await game.ctx.db
        .insert(configVersions)
        .values({ config, source: 'panel', effectiveFrom: game.clock.now() });
    }
    if (minute === 150) await claimLolo(game.ctx, { userId: eater, groupId: group }); // a player action settles first
    if (minute % step === 0 || minute === MINUTES) await settleAll(game);
  }

  const minted = await queryRows<{ code: string; total: string; rows: number }>(
    game.ctx.db,
    sql`SELECT w.system_code AS code, (-sum(e.amount))::text AS total, count(*)::int AS rows
        FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id
        WHERE w.system_code LIKE 'mint:%' GROUP BY 1 ORDER BY 1`,
  );
  const balances = [];
  for (const p of [eater, idle, streaker]) {
    balances.push([await cashOf(game, p), await treasuryOf(game, p)]);
  }
  return {
    balances,
    minted: Object.fromEntries(minted.map((m) => [m.code, m.total])),
    rows: Object.fromEntries(minted.map((m) => [m.code, m.rows])),
  };
}

describe('settlement cadence', () => {
  it('credits exactly the same amounts every minute, hourly, or only once', async () => {
    const everyMinute = await play(1);
    const hourly = await play(60);
    const once = await play(MINUTES);

    expect(hourly.balances).toEqual(everyMinute.balances);
    expect(once.balances).toEqual(everyMinute.balances);
    expect(hourly.minted).toEqual(everyMinute.minted);
    expect(once.minted).toEqual(everyMinute.minted);
    // Every kind of settled income took part.
    expect(Object.keys(everyMinute.minted)).toEqual(
      expect.arrayContaining(['mint:cemetery', 'mint:food', 'mint:interest', 'mint:streak']),
    );

    // …with far fewer ledger rows.
    expect(everyMinute.rows['mint:cemetery']).toBeGreaterThan(400);
    expect(hourly.rows['mint:cemetery']).toBeLessThanOrEqual(12);
    expect(hourly.rows['mint:food']).toBeLessThan(everyMinute.rows['mint:food']!);
  }, 240_000);
});

describe('unsettled income in displays', () => {
  it('ranks and totals as if everyone had just been settled', async () => {
    const game = await createTestGame('2026-10-12T08:00:00Z');
    games.push(game);
    const g = await newGroup(game);
    const idle = await newPlayer(game, 'بی‌کار');
    const busy = await newPlayer(game, 'پرکار');
    await grantPoints(game, idle, 1_000);
    await openCemetery(game.ctx, { userId: idle }); // cash 0, then 50 points an hour
    await setLevel(game, idle, 4);
    await giveFood(game, idle, 'chicken', 1);
    await eat(game.ctx, { userId: idle, food: 'chicken', count: 1 });
    await claimLolo(game.ctx, { userId: idle, groupId: g });
    await grantPoints(game, busy, 40);
    await claimLolo(game.ctx, { userId: busy, groupId: g });

    game.clock.advance(37 * 60_000 + 123); // 37 min: 30.8 points of cemetery, all 6 chicken deposits
    const before = await scaryLeaderboard(game.ctx, { groupId: g });
    const pending = (await economyOverview(game.ctx)).circulation.pendingCenti;
    expect(before.map((e) => e.displayName)).toEqual(['بی‌کار', 'پرکار']);

    const recorded = (await cashOf(game, idle)) + (await treasuryOf(game, idle));
    await settleAll(game);
    const settled = (await cashOf(game, idle)) + (await treasuryOf(game, idle));
    expect(settled - recorded).toBe(pending);
    expect(before[0]!.pointsCenti).toBe(settled);
    expect(await scaryLeaderboard(game.ctx, { groupId: g })).toEqual(before);
    expect((await economyOverview(game.ctx)).circulation.pendingCenti).toBe(0n);
  });
});
