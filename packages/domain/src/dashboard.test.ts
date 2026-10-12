import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimLolo } from './lolo.ts';
import { economyOverview } from './dashboard.ts';
import { upgradeLevel } from './levels.ts';
import { settleDuePlayers } from './settlement-job.ts';
import { depositToTreasury } from './treasury.ts';
import type { TestGame } from './testing.ts';
import { createTestGame, grantPoints, newGroup, newPlayer } from './testing.ts';

let game: TestGame;
beforeEach(async () => {
  // 11:30 Tehran on 2 October 2026 (Mehr 10).
  game = await createTestGame('2026-10-02T08:00:00Z');
});
afterEach(async () => {
  await game.close();
});

const nextDayAt = (hourUtc: number) => {
  const now = game.clock.now();
  game.clock.set(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hourUtc)),
  );
};

describe('economy overview', () => {
  it('counts circulation, sources, sinks and admin corrections from the ledger', async () => {
    const p1 = await newPlayer(game);
    const p2 = await newPlayer(game);
    const g = await newGroup(game);

    // Day 1 (2026-10-02): lolo +1, admin grant +1000, level upgrade −300, 500 to treasury.
    await claimLolo(game.ctx, { userId: p1, groupId: g });
    await grantPoints(game, p1, 1000);
    expect((await upgradeLevel(game.ctx, { userId: p1, expectedLevel: 1 })).status).toBe('ok');
    await depositToTreasury(game.ctx, { userId: p1, amountCenti: 50_000n });

    // Day 2: at midnight, interest 3 % of 500 = +15 and p1's day-1 streak reward +10;
    // then p2 lolo +1.
    nextDayAt(7);
    await settleDuePlayers(game.ctx);
    await claimLolo(game.ctx, { userId: p2, groupId: g });

    const o = await economyOverview(game.ctx);
    expect(o.today).toBe('2026-10-03');
    expect(o.players).toEqual({ total: 2, banned: 0, activeToday: 1, active7d: 2, active30d: 2 });
    expect(o.groups).toEqual({ total: 1, withBot: 1, activeToday: 1 });

    // Cash 1 + 1000 − 300 − 500 + 10 + 1 = 212; treasury 500 + 15 = 515.
    expect(o.circulation.now).toMatchObject({
      date: '2026-10-03',
      cash: 21_200n,
      treasury: 51_500n,
      bloodBank: 0n,
      total: 72_700n,
    });
    const day = (date: string) => o.circulation.daily.find((d) => d.date === date)!;
    expect(o.circulation.daily).toHaveLength(31);
    expect(day('2026-10-02').total).toBe(70_100n);
    expect(day('2026-10-01').total).toBe(0n);
    expect(o.circulation.daily[0]!.date).toBe('2026-09-03');

    expect(o.flows.today).toEqual({
      produced: [
        { code: 'mint:interest', centi: 1_500n },
        { code: 'mint:streak', centi: 1_000n },
        { code: 'mint:lolo', centi: 100n },
      ],
      consumed: [],
      adjustments: 0n,
      net: 2_600n,
    });
    expect(o.flows.month).toEqual({
      produced: [
        { code: 'mint:interest', centi: 1_500n },
        { code: 'mint:streak', centi: 1_000n },
        { code: 'mint:lolo', centi: 200n },
      ],
      consumed: [{ code: 'burn:level_upgrade', centi: 30_000n }],
      adjustments: 100_000n,
      net: 72_700n,
    });
    // The daily series agrees with the flows.
    expect(o.circulation.now.total - day('2026-10-02').total).toBe(o.flows.today.net);
  });

  it('warns about inflation only above the thresholds and a minimum circulation', async () => {
    const p = await newPlayer(game);
    await grantPoints(game, p, 5_000); // day 1: below the 10 000-point minimum

    nextDayAt(8);
    await grantPoints(game, p, 15_000); // day 2: 20 000
    nextDayAt(8);
    await grantPoints(game, p, 1_000); // day 3: 21 000 (+5 %)
    nextDayAt(8); // today = day 4

    let o = await economyOverview(game.ctx);
    expect(o.inflation.day).toMatchObject({
      from: '2026-10-03',
      to: '2026-10-04',
      baseCenti: 2_000_000n,
      changeCenti: 100_000n,
      growthBp: 500,
      thresholdBp: 1000,
      exceeded: false,
    });
    // The 7-day base (end of 2026-09-27) was empty: not judged.
    expect(o.inflation.week.growthBp).toBeNull();
    expect(o.inflation.status).toBe('ok');

    await grantPoints(game, p, 5_000); // today, so not yet counted
    nextDayAt(8); // day 5: yesterday grew 26 000 / 21 000 − 1 ≈ 23.8 %
    o = await economyOverview(game.ctx);
    expect(o.inflation.day.growthBp).toBe(2380);
    expect(o.inflation.day.exceeded).toBe(true);
    expect(o.inflation.status).toBe('warning');
  });

  it('has nothing to judge on an empty game', async () => {
    const o = await economyOverview(game.ctx);
    expect(o.inflation.status).toBe('not_enough_data');
    expect(o.circulation.now.total).toBe(0n);
    expect(o.flows.month).toEqual({ produced: [], consumed: [], adjustments: 0n, net: 0n });
  });
});
