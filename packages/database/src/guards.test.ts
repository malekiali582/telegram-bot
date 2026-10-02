import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, ledgerEntries, transactions, wallets } from './schema.ts';
import type { PlayerFixture, TestDatabase } from './testing.ts';
import {
  createPlayerFixture,
  createTestDatabase,
  postTransaction,
  systemWalletId,
  testBackend,
  walletBalance,
} from './testing.ts';
import { PG_ERROR, pgErrorCode, queryRows } from './tx.ts';

let t: TestDatabase;
let player: PlayerFixture;
let mintLolo: number;
let burnTool: number;

beforeAll(async () => {
  t = await createTestDatabase();
  player = await createPlayerFixture(t.db);
  mintLolo = await systemWalletId(t.db, 'mint:lolo');
  burnTool = await systemWalletId(t.db, 'burn:tool');
});
afterAll(async () => {
  await t.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return pgErrorCode(err);
  }
}

const mint = (walletId: number, amount: bigint) =>
  t.db.transaction((tx) =>
    postTransaction(tx, [
      { walletId: mintLolo, amount: -amount },
      { walletId, amount },
    ]),
  );

describe(`ledger guards (${testBackend()})`, () => {
  it('moves balances through ledger entries and records balance_after', async () => {
    const txId = await mint(player.cashWalletId, 150_000n);
    expect(await walletBalance(t.db, player.cashWalletId)).toBe(150_000n);
    const entries = await t.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, txId));
    const byWallet = new Map(entries.map((e) => [e.walletId, [e.amount, e.balanceAfter]]));
    expect(byWallet.get(player.cashWalletId)).toEqual([150_000n, 150_000n]);
    // system wallets keep no running balance (no hot row lock), so no balance_after
    expect(byWallet.get(mintLolo)).toEqual([-150_000n, null]);
  });

  it('keeps every user/group wallet balance equal to the sum of its entries', async () => {
    const mismatches = await queryRows(
      t.db,
      sql`
      SELECT w.id FROM wallets w
      LEFT JOIN ledger_entries e ON e.wallet_id = w.id
      WHERE w.kind <> 'system'
      GROUP BY w.id, w.balance
      HAVING w.balance <> coalesce(sum(e.amount), 0)`,
    );
    expect(mismatches).toEqual([]);
  });

  it('rejects an unbalanced transaction at commit and persists nothing', async () => {
    const before = await walletBalance(t.db, player.cashWalletId);
    const code = await codeOf(
      t.db.transaction((tx) =>
        postTransaction(tx, [{ walletId: player.cashWalletId, amount: 1n }]),
      ),
    );
    expect(code).toBe(PG_ERROR.checkViolation);
    expect(await walletBalance(t.db, player.cashWalletId)).toBe(before);
  });

  it('accepts entries inserted one by one inside a transaction (check is deferred)', async () => {
    await expect(mint(player.treasuryWalletId, 1n)).resolves.toBeTypeOf('number');
  });

  it('never lets a user wallet go negative; system wallets total via their entries', async () => {
    const balance = await walletBalance(t.db, player.cashWalletId);
    const code = await codeOf(
      t.db.transaction((tx) =>
        postTransaction(tx, [
          { walletId: player.cashWalletId, amount: -(balance + 1n) },
          { walletId: burnTool, amount: balance + 1n },
        ]),
      ),
    );
    expect(code).toBe(PG_ERROR.checkViolation);
    expect(await walletBalance(t.db, mintLolo)).toBe(0n);
    const [minted] = await queryRows<{ total: string }>(
      t.db,
      sql`SELECT sum(amount)::text AS total FROM ledger_entries WHERE wallet_id = ${mintLolo}`,
    );
    expect(BigInt(minted?.total ?? '0')).toBeLessThan(0n);
  });

  it('forbids changing a balance directly or creating a wallet with money in it', async () => {
    expect(
      await codeOf(
        t.db.update(wallets).set({ balance: 999_999n }).where(eq(wallets.id, player.cashWalletId)),
      ),
    ).toBe(PG_ERROR.checkViolation);
    expect(
      await codeOf(
        t.db.insert(wallets).values({ kind: 'system', systemCode: 'mint:test', balance: 5n }),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });

  it('makes transactions, ledger entries and audit logs append-only', async () => {
    const [entry] = await t.db.select().from(ledgerEntries).limit(1);
    if (!entry) throw new Error('expected a ledger entry');

    expect(
      await codeOf(
        t.db.update(ledgerEntries).set({ amount: 1n }).where(eq(ledgerEntries.id, entry.id)),
      ),
    ).toBe(PG_ERROR.restrictViolation);
    expect(await codeOf(t.db.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id)))).toBe(
      PG_ERROR.restrictViolation,
    );
    expect(
      await codeOf(
        t.db
          .update(transactions)
          .set({ reason: 'x' })
          .where(eq(transactions.id, entry.transactionId)),
      ),
    ).toBe(PG_ERROR.restrictViolation);
    expect(await codeOf(t.db.execute(sql`TRUNCATE ledger_entries CASCADE`))).toBe(
      PG_ERROR.restrictViolation,
    );

    const [log] = await t.db
      .insert(auditLogs)
      .values({ actor: 'system', action: 'test' })
      .returning({ id: auditLogs.id });
    expect(await codeOf(t.db.delete(auditLogs).where(eq(auditLogs.id, log!.id)))).toBe(
      PG_ERROR.restrictViolation,
    );
  });

  it('stores balances far beyond bigint range exactly (numeric(78,0))', async () => {
    const other = await createPlayerFixture(t.db, 'ثروتمند');
    const huge = 10n ** 70n + 12_345n;
    await mint(other.treasuryWalletId, huge);
    expect(await walletBalance(t.db, other.treasuryWalletId)).toBe(huge);
  });
});
