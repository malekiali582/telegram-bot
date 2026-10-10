/**
 * Acceptance 14 (owner request 2026-10-10): the daily group-activity reward with a
 * per-group streak. Growth and reset of the streak, the 20-member cap, the choice of
 * group for a player active in several, accounts younger than 3 days, payment exactly
 * at Tehran midnight, and never twice (also under concurrency on real PostgreSQL).
 */
import { streakRewards, transactions } from '@lulu/database';
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import { addDays, claimLolo, settleDuePlayers, treasuryView } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  banPlayer,
  cashOf,
  createTestGame,
  newGroup,
  newPlayer,
  tehranTime,
} from '@lulu/domain/testing';
import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.rng.fallback = 'min';
});

const D0 = '2026-10-01';
/** «لولو» by `userId` in `groupId` at noon (plus `minutes`) of a Tehran day. */
async function loloOn(userId: number, groupId: number, day: string, minutes = 0) {
  game.clock.set(new Date(tehranTime(day, '12:00:00').getTime() + minutes * 60_000));
  const r = await claimLolo(game.ctx, { userId, groupId });
  if (r.status !== 'ok') throw new Error(`lolo: ${r.status}`);
  return r;
}
/** Settles the player as of a Tehran wall-clock time (any action settles first). */
async function settleAt(userId: number, day: string, time = '00:00:00') {
  game.clock.set(tehranTime(day, time));
  await treasuryView(game.ctx, userId);
}
async function rewardsOf(userId: number) {
  const rows = await game.ctx.db
    .select()
    .from(streakRewards)
    .where(eq(streakRewards.userId, userId))
    .orderBy(asc(streakRewards.tehranDate));
  return rows.map((r) => ({
    day: r.tehranDate,
    group: r.groupId,
    streak: r.streak,
    active: r.activeMembers,
    personal: Number(r.personalCenti / 100n),
    group$: Number(r.groupCenti / 100n),
  }));
}
/** `n` players whose first lolo (in a scratch group) was on `firstDay`. */
async function playersSince(n: number, firstDay: string) {
  const scratch = await newGroup(game, 'آغاز');
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = await newPlayer(game);
    await loloOn(id, scratch, firstDay);
    ids.push(id);
  }
  return ids;
}

describe(`acceptance 14 — streak growth and reset (${testBackend()})`, () => {
  it('pays 10, 15, 20 … for consecutive days and starts over after a day without lolo', async () => {
    const g = await newGroup(game);
    const [p] = await playersSince(1, D0); // first lolo D0, in another group
    const days = [1, 2, 3, 5].map((d) => addDays(D0, d)); // day 4 is skipped
    for (const day of days) await loloOn(p!, g, day);
    await settleAt(p!, addDays(D0, 6));
    const rewards = await rewardsOf(p!);
    // D0 itself was a streak day in the scratch group (streak 1, no mature members yet)
    expect(rewards.map((r) => [r.day, r.streak, r.personal])).toEqual([
      [D0, 1, 10],
      [days[0], 1, 10],
      [days[1], 2, 15],
      [days[2], 3, 20],
      [days[3], 1, 10], // reset after the missed day
    ]);
    // the player counts as an active member from D0 + 3 on
    expect(rewards.map((r) => r.active)).toEqual([0, 0, 0, 1, 1]);
    expect(rewards.map((r) => r.group$)).toEqual([0, 0, 0, 100, 100]);
  });

  it('stays at 155 from day 30 of a streak', async () => {
    const g = await newGroup(game);
    const p = await newPlayer(game);
    const start = '2026-11-01';
    for (let d = 0; d < 32; d++) await loloOn(p, g, addDays(start, d));
    await settleAt(p, addDays(start, 32));
    const rewards = await rewardsOf(p);
    expect(rewards).toHaveLength(32);
    expect(rewards.slice(27).map((r) => [r.streak, r.personal])).toEqual([
      [28, 145],
      [29, 150],
      [30, 155],
      [31, 155],
      [32, 155],
    ]);
  });
});

describe(`acceptance 14 — group reward (${testBackend()})`, () => {
  it('counts at most 20 active members: 100 × min(active, 20)', async () => {
    const day = addDays(D0, 10);
    const big = await newGroup(game, 'بزرگ');
    const members = await playersSince(25, addDays(day, -3));
    for (const m of members) await loloOn(m, big, day);
    await settleAt(members[0]!, addDays(day, 1));
    expect((await rewardsOf(members[0]!)).find((r) => r.day === day)).toMatchObject({
      group: big,
      active: 25,
      group$: 2_000, // not 2 500
    });

    const small = await newGroup(game, 'کوچک');
    const few = await playersSince(3, addDays(day, -5));
    for (const m of few) await loloOn(m, small, day);
    await settleAt(few[0]!, addDays(day, 1));
    expect((await rewardsOf(few[0]!)).find((r) => r.day === day)).toMatchObject({
      active: 3,
      group$: 300,
    });
  });

  it('does not count accounts whose first lolo was less than 3 days ago, but still pays them', async () => {
    const day = addDays(D0, 20);
    const g = await newGroup(game);
    const [old] = await playersSince(1, addDays(day, -3)); // exactly 3 days: counted
    const [young] = await playersSince(1, addDays(day, -2)); // 2 days: not counted
    const fresh = await newPlayer(game); // first lolo today
    for (const p of [old!, young!, fresh]) await loloOn(p, g, day);
    for (const p of [old!, young!, fresh]) await settleAt(p, addDays(day, 1));
    for (const p of [old!, young!, fresh]) {
      expect((await rewardsOf(p)).find((r) => r.day === day && r.group === g)).toMatchObject({
        active: 1,
        group$: 100,
      });
    }
    expect((await rewardsOf(fresh))[0]).toMatchObject({ streak: 1, personal: 10 });
  });

  it('neither counts nor pays banned players', async () => {
    const day = addDays(D0, 22);
    const g = await newGroup(game);
    const [a, b] = await playersSince(2, addDays(day, -4));
    await loloOn(a!, g, day);
    await loloOn(b!, g, day);
    await banPlayer(game, b!);
    await settleAt(a!, addDays(day, 1));
    await settleAt(b!, addDays(day, 1));
    expect((await rewardsOf(a!)).find((r) => r.day === day)).toMatchObject({ active: 1 });
    expect((await rewardsOf(b!)).find((r) => r.day === day)).toBeUndefined();
  });
});

describe(`acceptance 14 — a player in several groups (${testBackend()})`, () => {
  it('is paid once a day, from the group with the most active members', async () => {
    const day = addDays(D0, 30);
    const quiet = await newGroup(game, 'خلوت');
    const busy = await newGroup(game, 'شلوغ');
    const [p, ...others] = await playersSince(6, addDays(day, -5));
    for (const o of others.slice(0, 1)) await loloOn(o, quiet, day); // quiet: 2 with p
    for (const o of others.slice(1)) await loloOn(o, busy, day); // busy: 5 with p
    await loloOn(p!, quiet, day, 1);
    await loloOn(p!, busy, day, 10);
    // the next day only in the quiet group: its streak went on regardless
    await loloOn(p!, quiet, addDays(day, 1));
    await settleAt(p!, addDays(day, 2));
    const rewards = (await rewardsOf(p!)).filter((r) => r.day >= day);
    expect(rewards).toEqual([
      { day, group: busy, streak: 1, active: 5, personal: 10, group$: 500 },
      { day: addDays(day, 1), group: quiet, streak: 2, active: 1, personal: 15, group$: 100 },
    ]);
  });

  it('on a tie in active members, takes the group with the longer streak', async () => {
    const day = addDays(D0, 40);
    const g1 = await newGroup(game);
    const g2 = await newGroup(game);
    const [p, x, y] = await playersSince(3, addDays(day, -6));
    await loloOn(p!, g2, addDays(day, -2));
    await loloOn(p!, g2, addDays(day, -1)); // streak in g2 reaches 3 today
    await loloOn(x!, g1, day);
    await loloOn(y!, g2, day);
    await loloOn(p!, g1, day, 1);
    await loloOn(p!, g2, day, 10);
    await settleAt(p!, addDays(day, 1));
    expect((await rewardsOf(p!)).find((r) => r.day === day)).toMatchObject({
      group: g2,
      streak: 3,
      active: 2,
      personal: 20,
    });
  });
});

describe(`acceptance 14 — paid at midnight, exactly once (${testBackend()})`, () => {
  it('pays nothing before Tehran midnight and the whole day at 00:00', async () => {
    const day = addDays(D0, 50);
    const g = await newGroup(game);
    const p = await newPlayer(game);
    await loloOn(p, g, day);
    await settleAt(p, day, '23:59:59.999');
    expect(await rewardsOf(p)).toEqual([]);
    await settleAt(p, addDays(day, 1), '00:00:00');
    expect(await rewardsOf(p)).toHaveLength(1);
  });

  it('pays each missed day once after downtime, and never again on repeated runs', async () => {
    const start = addDays(D0, 60);
    const g = await newGroup(game);
    const p = await newPlayer(game);
    for (let d = 0; d < 4; d++) await loloOn(p, g, addDays(start, d));
    const before = await cashOf(game, p);
    // the server was down for days: the worker and the player catch up together
    game.clock.set(tehranTime(addDays(start, 9), '08:00:00'));
    await settleDuePlayers(game.ctx);
    await settleDuePlayers(game.ctx);
    await treasuryView(game.ctx, p);
    await settleAt(p, addDays(start, 10));
    const rewards = await rewardsOf(p);
    expect(rewards.map((r) => [r.streak, r.personal])).toEqual([
      [1, 10],
      [2, 15],
      [3, 20],
      [4, 25],
    ]);
    // each lolo already settled the days before it; only the last day was still owed:
    // personal 25, plus 100 because by then the player itself is 3 days old and counts
    expect((await cashOf(game, p)) - before).toBe(12_500n);
    const [paid] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.userId, p), eq(transactions.kind, 'streak_reward')));
    expect(paid?.n).toBe(4);
  });
});

describe.runIf(usingRealPostgres)(
  'acceptance 14 — concurrent settlement on real PostgreSQL',
  () => {
    it('five workers and the player at midnight pay each day once', async () => {
      const day = addDays(D0, 70);
      const g = await newGroup(game);
      const players = await playersSince(4, addDays(day, -3));
      for (const p of players) await loloOn(p, g, day);
      const before = await Promise.all(players.map((p) => cashOf(game, p)));
      game.clock.set(tehranTime(addDays(day, 1), '00:00:00'));
      await Promise.all([
        ...Array.from({ length: 5 }, () => settleDuePlayers(game.ctx)),
        ...players.map((p) => treasuryView(game.ctx, p)),
      ]);
      for (const [i, p] of players.entries()) {
        const rows = (await rewardsOf(p)).filter((r) => r.day === day);
        expect(rows).toHaveLength(1);
        // personal 10 (streak 1 in this group) + 4 active members × 100
        expect((await cashOf(game, p)) - before[i]!).toBe(41_000n);
      }
    });
  },
);
