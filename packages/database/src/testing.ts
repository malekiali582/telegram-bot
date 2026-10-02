import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { DatabaseHandle } from './client.ts';
import { connectPostgres, migrateDatabase } from './client.ts';
import { openPglite } from './pglite.ts';
import { ledgerEntries, playerState, transactions, users, wallets } from './schema.ts';
import type { Executor } from './tx.ts';

/**
 * Test databases. The backend is chosen per run:
 *   - `npm test`      → PGlite (in-process, single connection; fast)
 *   - `npm run test:pg` → real PostgreSQL: TEST_DATABASE_URL if set, otherwise an
 *     embedded server started by the vitest global setup.
 * Concurrency tests only mean something on real PostgreSQL; they use
 * `describe.runIf(usingRealPostgres)` and are reported as skipped under PGlite.
 */

export type TestBackend = 'pglite' | 'postgres';

export function testBackend(): TestBackend {
  return process.env.LULU_TEST_DB === 'postgres' ? 'postgres' : 'pglite';
}

export const usingRealPostgres = testBackend() === 'postgres';

export interface TestDatabase extends DatabaseHandle {
  backend: TestBackend;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'LULU_TEST_DB=postgres needs TEST_DATABASE_URL (set automatically by `npm run test:pg`)',
    );
  }
  return url;
}

/** A fresh, fully migrated, isolated database. Close it when the test file is done. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (testBackend() === 'pglite') {
    const handle = await openPglite();
    await migrateDatabase(handle);
    return { ...handle, backend: 'pglite' };
  }

  // One throwaway database per test file on the shared server.
  const name = `lulu_test_${randomBytes(6).toString('hex')}`;
  const base = new URL(adminUrl());
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const handle = connectPostgres(url.toString(), { max: 20, applicationName: 'lulu-test' });
  await migrateDatabase(handle);

  return {
    ...handle,
    backend: 'postgres',
    async close() {
      await handle.close();
      const cleanup = new pg.Client({ connectionString: base.toString() });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

// ───────────────────────── fixtures ─────────────────────────
// Raw building blocks for database-level tests. Domain services (step 4+) own the real
// rules for creating players and moving money; these only set up rows.

export interface PlayerFixture {
  userId: number;
  cashWalletId: number;
  treasuryWalletId: number;
}

export async function createPlayerFixture(
  db: Executor,
  displayName = 'بازیکن آزمایشی',
): Promise<PlayerFixture> {
  const [user] = await db.insert(users).values({ displayName }).returning({ id: users.id });
  if (!user) throw new Error('user insert returned nothing');
  await db.insert(playerState).values({ userId: user.id });
  const created = await db
    .insert(wallets)
    .values([
      { kind: 'user_cash', userId: user.id },
      { kind: 'user_treasury', userId: user.id },
    ])
    .returning({ id: wallets.id, kind: wallets.kind });
  const cash = created.find((w) => w.kind === 'user_cash');
  const treasury = created.find((w) => w.kind === 'user_treasury');
  if (!cash || !treasury) throw new Error('wallet insert returned nothing');
  return { userId: user.id, cashWalletId: cash.id, treasuryWalletId: treasury.id };
}

export async function systemWalletId(db: Executor, code: string): Promise<number> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(eq(wallets.systemCode, code));
  if (!row) throw new Error(`no system wallet ${code}`);
  return row.id;
}

export async function walletBalance(db: Executor, walletId: number): Promise<bigint> {
  const [row] = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  if (!row) throw new Error(`no wallet ${walletId}`);
  return row.balance;
}

/** Inserts a transaction and its ledger entries (the triggers move the balances). */
export async function postTransaction(
  db: Executor,
  entries: { walletId: number; amount: bigint }[],
  kind = 'test',
): Promise<number> {
  const [txRow] = await db
    .insert(transactions)
    .values({ kind, effectiveAt: new Date() })
    .returning({ id: transactions.id });
  if (!txRow) throw new Error('transaction insert returned nothing');
  for (const entry of entries) {
    await db.insert(ledgerEntries).values({ transactionId: txRow.id, ...entry });
  }
  return txRow.id;
}
