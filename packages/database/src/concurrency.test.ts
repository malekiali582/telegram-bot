import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { interestSettlements, jobRuns, outbox, playerState } from './schema.ts';
import type { TestDatabase } from './testing.ts';
import {
  createPlayerFixture,
  createTestDatabase,
  postTransaction,
  systemWalletId,
  usingRealPostgres,
  walletBalance,
} from './testing.ts';
import { PG_ERROR, inTransaction, lockPlayer, pgErrorCode, queryRows } from './tx.ts';

/**
 * Real concurrency: several pooled connections racing each other. PGlite has a single
 * connection, so these only run under `npm run test:pg` (embedded or external
 * PostgreSQL) and are reported as skipped otherwise.
 */
describe.runIf(usingRealPostgres)('concurrency on real PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs on several connections at once (sanity check)', async () => {
    const pids = await Promise.all(
      Array.from({ length: 4 }, () =>
        inTransaction(t.db, async (tx) => {
          const rows = await queryRows<{ pid: number }>(tx, sql`SELECT pg_backend_pid() AS pid`);
          await sleep(100);
          return rows[0]?.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(4);
  });

  it('never overspends a wallet under 20 concurrent debits', async () => {
    const player = await createPlayerFixture(t.db);
    const mint = await systemWalletId(t.db, 'mint:lolo');
    const burn = await systemWalletId(t.db, 'burn:tool');
    await t.db.transaction((tx) =>
      postTransaction(tx, [
        { walletId: mint, amount: -1_000n },
        { walletId: player.cashWalletId, amount: 1_000n },
      ]),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        t.db.transaction(async (tx) => {
          await postTransaction(tx, [
            { walletId: player.cashWalletId, amount: -100n },
            { walletId: burn, amount: 100n },
          ]);
          await sleep(5);
        }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toBe(10);
    expect(failures.map((f) => pgErrorCode(f.reason))).toEqual(
      Array(10).fill(PG_ERROR.checkViolation),
    );
    expect(await walletBalance(t.db, player.cashWalletId)).toBe(0n);
  });

  it('serializes actions on the same player through the player lock', async () => {
    const player = await createPlayerFixture(t.db);
    const events: string[] = [];

    const first = inTransaction(t.db, async (tx) => {
      await lockPlayer(tx, player.userId);
      events.push('A locked');
      await sleep(300);
      await tx.update(playerState).set({ level: 2 }).where(eq(playerState.userId, player.userId));
      events.push('A done');
    });
    await sleep(50);
    const second = inTransaction(t.db, async (tx) => {
      events.push('B waiting');
      const row = await lockPlayer(tx, player.userId);
      events.push(`B locked, saw level ${row?.level}`);
    });
    await Promise.all([first, second]);

    expect(events).toEqual(['A locked', 'B waiting', 'A done', 'B locked, saw level 2']);
  });

  it('hands out disjoint outbox rows to concurrent claimers (SKIP LOCKED)', async () => {
    await t.db.insert(outbox).values(
      Array.from({ length: 10 }, (_, i) => ({
        platform: 'telegram' as const,
        kind: 'send' as const,
        payload: { i },
      })),
    );

    const claim = () =>
      inTransaction(t.db, async (tx) => {
        const rows = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(eq(outbox.status, 'pending'))
          .orderBy(outbox.id)
          .limit(5)
          .for('update', { skipLocked: true });
        await sleep(200); // hold the locks while the other claimer runs
        return rows.map((r) => r.id);
      });

    const [a, b] = await Promise.all([claim(), claim()]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b]).size).toBe(10);
  });

  it('lets exactly one of 10 racing writers record the same midnight interest', async () => {
    const player = await createPlayerFixture(t.db);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        t.db.insert(interestSettlements).values({
          userId: player.userId,
          boundaryDate: '2026-10-03',
          balanceBefore: 100_000n,
          interest: 3_000n,
          rateBp: 300,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [row] = await t.db
      .select({ n: count() })
      .from(interestSettlements)
      .where(eq(interestSettlements.userId, player.userId));
    expect(row?.n).toBe(1);
  });

  it('retries a SERIALIZABLE write-skew conflict so exactly one writer wins', async () => {
    // Both transactions read "no run yet" before either writes; PostgreSQL aborts one
    // with 40001 and inTransaction re-runs it, which then sees the committed row.
    let attempts = 0;
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));

    const writer = (owner: string) =>
      inTransaction(
        t.db,
        async (tx) => {
          attempts++;
          const [row] = await tx
            .select({ n: count() })
            .from(jobRuns)
            .where(eq(jobRuns.jobName, 'write-skew'));
          if (++arrived === 2) release();
          await bothRead;
          if ((row?.n ?? 0) > 0) return 'skipped';
          await tx.insert(jobRuns).values({
            jobName: 'write-skew',
            leaseOwner: owner,
            startedAt: new Date(),
            status: 'running',
          });
          return 'inserted';
        },
        { isolationLevel: 'serializable' },
      );

    const outcomes = await Promise.all([writer('a'), writer('b')]);
    expect(outcomes.sort()).toEqual(['inserted', 'skipped']);
    expect(attempts).toBe(3);
    const [row] = await t.db
      .select({ n: count() })
      .from(jobRuns)
      .where(and(eq(jobRuns.jobName, 'write-skew')));
    expect(row?.n).toBe(1);
  });
});
