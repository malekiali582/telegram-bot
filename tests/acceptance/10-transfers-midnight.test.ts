/**
 * Acceptance 10 (spec §19.10): transfers near midnight, a late job, simultaneous
 * deposits/withdrawals, opposite-direction transfers, and conservation of money
 * except for authorized interest.
 */
import { queryRows, transactions } from '@lulu/database';
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import {
  depositToTreasury,
  settleDuePlayers,
  transfer,
  treasuryView,
  withdrawFromTreasury,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  banPlayer,
  cashOf,
  createTestGame,
  grantPoints,
  newPlayer,
  tehranTime,
  treasuryOf,
} from '@lulu/domain/testing';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});

const at = (date: string, time?: string) => game.clock.set(tehranTime(date, time));
const P = (points: number) => BigInt(points) * 100n;
const send = (from: number, to: number, points: number, key?: string) =>
  transfer(game.ctx, {
    fromUserId: from,
    toUserId: to,
    amountCenti: P(points),
    ...(key ? { idempotencyKey: key } : {}),
  });
const interestPaidTo = async (userIds: number[]) => {
  const [row] = await queryRows<{ total: string }>(
    game.ctx.db,
    sql`SELECT coalesce(sum(interest), 0)::text AS total FROM interest_settlements
        WHERE user_id IN (${sql.join(
          userIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
  );
  return BigInt(row?.total ?? '0');
};
const holdings = async (userIds: number[]) => {
  let total = 0n;
  for (const id of userIds) total += (await cashOf(game, id)) + (await treasuryOf(game, id));
  return total;
};

/** Two players registered at noon; A has 1000 points in the treasury. */
async function pair() {
  at('2026-10-02', '12:00:00');
  const a = await newPlayer(game, 'الف');
  const b = await newPlayer(game, 'ب');
  await grantPoints(game, a, 1000);
  await depositToTreasury(game.ctx, { userId: a, amountCenti: P(1000) });
  return { a, b };
}

describe(`acceptance 10 — transfers and midnight (${testBackend()})`, () => {
  it('money moved from A to B just before midnight earns that night once, for B', async () => {
    const { a, b } = await pair();
    at('2026-10-02', '23:59:59.000');
    await withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(1000) });
    await send(a, b, 1000);
    at('2026-10-02', '23:59:59.900');
    await depositToTreasury(game.ctx, { userId: b, amountCenti: P(1000) });
    at('2026-10-03', '01:00:00');
    await settleDuePlayers(game.ctx);
    expect(await treasuryOf(game, a)).toBe(0n);
    expect(await treasuryOf(game, b)).toBe(P(1030));
    expect(await interestPaidTo([a, b])).toBe(P(30));
  });

  it('money moved just after midnight, before the job ran, is not paid twice', async () => {
    const { a, b } = await pair();
    at('2026-10-03', '00:00:01');
    await withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(1030) }); // A settles first
    await send(a, b, 1030);
    await depositToTreasury(game.ctx, { userId: b, amountCenti: P(1030) });
    at('2026-10-03', '00:20:00'); // the late job
    await settleDuePlayers(game.ctx);
    expect(await interestPaidTo([a, b])).toBe(P(30));
    expect(await holdings([a, b])).toBe(P(1030));
    // next night: only B's 1030 earns
    at('2026-10-04', '00:20:00');
    await settleDuePlayers(game.ctx);
    expect(await treasuryOf(game, b)).toBe(P(1030) + (P(1030) * 300n) / 10_000n);
  });

  it('conserves money: holdings change only by interest', async () => {
    const { a, b } = await pair();
    const before = await holdings([a, b]);
    at('2026-10-02', '18:00:00');
    await withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(400) });
    await send(a, b, 250);
    await depositToTreasury(game.ctx, { userId: b, amountCenti: P(100) });
    await send(b, a, 50);
    at('2026-10-05', '10:00:00');
    await treasuryView(game.ctx, a);
    await treasuryView(game.ctx, b);
    expect(await holdings([a, b])).toBe(before + (await interestPaidTo([a, b])));
  });

  it('validates transfers and changes nothing on refusal', async () => {
    const { a, b } = await pair();
    at('2026-10-02', '13:00:00');
    await withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(100) });
    expect(await send(a, a, 10)).toEqual({ status: 'self_transfer' });
    expect(await send(a, 999_999, 10)).toEqual({ status: 'unknown_recipient' });
    expect(await transfer(game.ctx, { fromUserId: a, toUserId: b, amountCenti: 0n })).toEqual({
      status: 'invalid_amount',
    });
    expect(await send(a, b, 101)).toEqual({ status: 'insufficient_funds', availableCenti: P(100) });
    const banned = await newPlayer(game);
    await banPlayer(game, banned);
    expect(await send(a, banned, 10)).toEqual({ status: 'recipient_banned' });
    expect(await cashOf(game, a)).toBe(P(100));
  });

  it('dedupes a repeated transfer confirmation', async () => {
    const { a, b } = await pair();
    at('2026-10-02', '13:00:00');
    await withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(100) });
    expect((await send(a, b, 40, 'transfer:abc')).status).toBe('ok');
    expect(await send(a, b, 40, 'transfer:abc')).toEqual({ status: 'duplicate' });
    expect(await cashOf(game, b)).toBe(P(40));
  });
});

describe(`acceptance 10 — concurrency (${testBackend()})`, () => {
  it('runs 20 opposite-direction transfers at once without deadlock or loss', async () => {
    at('2026-10-02', '14:00:00');
    const a = await newPlayer(game);
    const b = await newPlayer(game);
    await grantPoints(game, a, 500);
    await grantPoints(game, b, 500);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? send(a, b, 10) : send(b, a, 10))),
    );
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(await cashOf(game, a)).toBe(P(500));
    expect(await cashOf(game, b)).toBe(P(500));
  });

  it('lets exactly 10 of 20 simultaneous transfers drain 100 points', async () => {
    at('2026-10-02', '14:00:00');
    const a = await newPlayer(game);
    await grantPoints(game, a, 100);
    const others = await Promise.all(Array.from({ length: 4 }, () => newPlayer(game)));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => send(a, others[i % 4]!, 10)),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'insufficient_funds')).toHaveLength(10);
    expect(await cashOf(game, a)).toBe(0n);
    expect(await holdings(others)).toBe(P(100));
  });

  it('keeps cash + treasury constant under simultaneous deposits and withdrawals', async () => {
    at('2026-10-02', '15:00:00');
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 1000);
    await depositToTreasury(game.ctx, { userId, amountCenti: P(500) });
    const moves = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? depositToTreasury(game.ctx, { userId, amountCenti: P(30) })
        : withdrawFromTreasury(game.ctx, { userId, amountCenti: P(20) }),
    );
    const results = await Promise.all(moves);
    const ok = results.filter((r) => r.status === 'ok').length;
    expect(ok).toBe(20);
    expect(await holdings([userId])).toBe(P(1000));
    expect(await treasuryOf(game, userId)).toBe(P(500 + 10 * 30 - 10 * 20));
  });
});

describe.runIf(usingRealPostgres)('acceptance 10 — midnight races on real PostgreSQL', () => {
  it('transfers racing the midnight job pay each night once in total', async () => {
    const { a, b } = await pair();
    await grantPoints(game, b, 1000);
    at('2026-10-03', '00:00:05');
    await Promise.all([
      settleDuePlayers(game.ctx),
      withdrawFromTreasury(game.ctx, { userId: a, amountCenti: P(500) }).then(() =>
        send(a, b, 500),
      ),
      send(b, a, 300),
      depositToTreasury(game.ctx, { userId: b, amountCenti: P(200) }),
      settleDuePlayers(game.ctx),
    ]);
    await settleDuePlayers(game.ctx);
    expect(await interestPaidTo([a, b])).toBe(P(30));
    expect(await holdings([a, b])).toBe(P(2030));
    const [rows] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.kind, 'interest'), eq(transactions.userId, a)));
    expect(rows?.n).toBe(1);
  });
});
