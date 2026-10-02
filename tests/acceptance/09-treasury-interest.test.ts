/**
 * Acceptance 9 (spec §19.9): treasury interest 1000 → 1030 → 1060.9 over two Tehran
 * midnights; a deposit after midnight earns nothing for that night; downtime and
 * repeated or concurrent jobs never pay a night twice or skip one.
 */
import { interestSettlements, transactions } from '@lulu/database';
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import {
  ConfigProvider,
  createDomainContext,
  depositToTreasury,
  settleDuePlayers,
  treasuryView,
  withdrawFromTreasury,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  cashOf,
  createTestGame,
  grantPoints,
  newPlayer,
  tehranTime,
  treasuryOf,
} from '@lulu/domain/testing';
import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});

const at = (date: string, time?: string) => game.clock.set(tehranTime(date, time));
const view = async (userId: number) => {
  const v = await treasuryView(game.ctx, userId);
  if (v.status !== 'ok') throw new Error(v.status);
  return v;
};
const deposit = (userId: number, points: number) =>
  depositToTreasury(game.ctx, { userId, amountCenti: BigInt(points) * 100n });
const withdraw = (userId: number, points: number) =>
  withdrawFromTreasury(game.ctx, { userId, amountCenti: BigInt(points) * 100n });
const settlementsOf = (userId: number) =>
  game.ctx.db
    .select()
    .from(interestSettlements)
    .where(eq(interestSettlements.userId, userId))
    .orderBy(asc(interestSettlements.boundaryDate));

/** Registered on `date` at noon Tehran with `points` in the treasury. */
async function saver(date: string, points: number) {
  at(date, '12:00:00');
  const userId = await newPlayer(game);
  await grantPoints(game, userId, points);
  expect((await deposit(userId, points)).status).toBe('ok');
  return userId;
}

describe(`acceptance 9 — treasury interest (${testBackend()})`, () => {
  it('compounds 1000 → 1030 → 1060.9 over two Tehran midnights, into the treasury', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-03', '00:30:00');
    expect((await view(userId)).treasuryCenti).toBe(103_000n);
    at('2026-10-04', '00:30:00');
    const v = await view(userId);
    expect(v.treasuryCenti).toBe(106_090n); // 1060.90
    expect(v.cashCenti).toBe(0n); // never paid to cash
    expect(v.lastInterest).toEqual({ boundaryDate: '2026-10-04', interestCenti: 3_090n });
    expect(
      (await settlementsOf(userId)).map((s) => [s.boundaryDate, s.balanceBefore, s.interest]),
    ).toEqual([
      ['2026-10-03', 100_000n, 3_000n],
      ['2026-10-04', 103_000n, 3_090n],
    ]);
  });

  it('gives the same result whether settled every night or once after both', async () => {
    const eager = await saver('2026-10-02', 1000);
    const lazy = await saver('2026-10-02', 1000);
    at('2026-10-03', '00:00:01');
    await view(eager);
    at('2026-10-04', '00:00:01');
    await view(eager);
    at('2026-10-05', '09:00:00');
    expect(await treasuryOf(game, lazy)).toBe(100_000n); // nothing settled for lazy yet
    expect((await view(lazy)).treasuryCenti).toBe((await view(eager)).treasuryCenti);
  });

  it('a deposit at exactly 00:00:00 earns nothing for that midnight; one ms earlier does', async () => {
    at('2026-10-02', '12:00:00');
    const late = await newPlayer(game);
    const early = await newPlayer(game);
    await grantPoints(game, late, 1000);
    await grantPoints(game, early, 1000);
    at('2026-10-02', '23:59:59.999');
    await deposit(early, 1000);
    at('2026-10-03', '00:00:00');
    await deposit(late, 1000);
    at('2026-10-03', '08:00:00');
    expect((await view(early)).treasuryCenti).toBe(103_000n);
    expect((await view(late)).treasuryCenti).toBe(100_000n);
  });

  it("a withdrawal right after midnight keeps that night's interest", async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-03', '00:00:00');
    expect(await withdraw(userId, 1000)).toMatchObject({ status: 'ok', treasuryCenti: 3_000n });
    expect(await cashOf(game, userId)).toBe(100_000n);
  });

  it('pays every night missed during a 5-day downtime, compounding, exactly once', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-07', '18:00:00'); // nothing ran for 5 midnights
    let expected = 100_000n;
    for (let night = 0; night < 5; night++) expected += (expected * 300n) / 10_000n;
    expect((await view(userId)).treasuryCenti).toBe(expected);
    expect(await settlementsOf(userId)).toHaveLength(5);
  });

  it('survives a restart: a fresh process context settles the same way', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-04', '03:00:00');
    const restarted = createDomainContext(game.ctx.db, {
      clock: game.clock,
      rng: game.rng,
      config: new ConfigProvider(),
    });
    const v = await treasuryView(restarted, userId);
    expect(v).toMatchObject({ status: 'ok', treasuryCenti: 106_090n });
  });

  it('a job that runs late or twice pays nothing extra', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-03', '05:00:00'); // job is 5 hours late
    await settleDuePlayers(game.ctx);
    await settleDuePlayers(game.ctx);
    at('2026-10-03', '23:00:00'); // same day, runs again
    await settleDuePlayers(game.ctx);
    expect(await treasuryOf(game, userId)).toBe(103_000n);
    const [rows] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.kind, 'interest')));
    expect(rows?.n).toBe(1);
  });

  it('a player action before the late job settles first; the job then adds nothing', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-03', '00:05:00');
    await withdraw(userId, 500); // settles the midnight first
    await settleDuePlayers(game.ctx);
    expect(await treasuryOf(game, userId)).toBe(53_000n);
  });

  it('rejects zero, negative and excessive amounts without changing anything', async () => {
    const userId = await saver('2026-10-02', 100);
    expect(await depositToTreasury(game.ctx, { userId, amountCenti: 0n })).toEqual({
      status: 'invalid_amount',
    });
    expect(await withdrawFromTreasury(game.ctx, { userId, amountCenti: -1n })).toEqual({
      status: 'invalid_amount',
    });
    expect(await withdraw(userId, 101)).toEqual({
      status: 'insufficient_funds',
      availableCenti: 10_000n,
    });
    expect(await deposit(userId, 1)).toEqual({ status: 'insufficient_funds', availableCenti: 0n });
  });
});

describe.runIf(usingRealPostgres)('acceptance 9 — concurrent settlement on real PostgreSQL', () => {
  it('pays each midnight once while jobs and player actions race', async () => {
    const userId = await saver('2026-10-02', 1000);
    at('2026-10-05', '00:10:00');
    await Promise.all([
      settleDuePlayers(game.ctx),
      settleDuePlayers(game.ctx),
      treasuryView(game.ctx, userId),
      treasuryView(game.ctx, userId),
      settleDuePlayers(game.ctx),
    ]);
    let expected = 100_000n;
    for (let night = 0; night < 3; night++) expected += (expected * 300n) / 10_000n;
    expect(await treasuryOf(game, userId)).toBe(expected);
    expect(await settlementsOf(userId)).toHaveLength(3);
  });
});
