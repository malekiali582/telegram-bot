import type { Executor, Tx } from '@lulu/database';
import { ledgerEntries, transactions, wallets } from '@lulu/database';
import { and, eq } from 'drizzle-orm';
import { DomainError } from './context.ts';

/** Source (mint), sink (burn) and adjustment accounts, seeded by migrations 0001, 0005 and 0006. */
export type SystemWalletCode =
  | 'mint:lolo'
  | 'mint:food'
  | 'mint:cemetery'
  | 'mint:interest'
  | 'mint:ghost'
  | 'mint:streak'
  | 'burn:level_upgrade'
  | 'burn:tool'
  | 'burn:cemetery'
  | 'burn:city_upgrade'
  | 'burn:blood_bank_upgrade'
  | 'burn:hunting_ground_upgrade'
  | 'burn:curse'
  | 'adjust:admin';

export interface LedgerEntry {
  walletId: number;
  /** Signed centi-points: positive credits the wallet, negative debits it. */
  amount: bigint;
}

export interface TransactionInput {
  kind: string;
  effectiveAt: Date;
  entries: LedgerEntry[];
  userId?: number;
  groupId?: number;
  configVersionId?: number;
  adminUserId?: number;
  reason?: string;
  requestId?: string;
  /** Unique per logical request (e.g. a confirmation button); repeats are rejected by the DB. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records a transaction and its double-entry lines. Entries may be empty for actions
 * that move no money but need an audit row (hunt attempts, eating).
 *
 * The database moves the balances (trigger), rejects negative user/group balances
 * and unbalanced transactions; these checks fail fast in code too. Entries are
 * written in wallet-id order so concurrent transactions lock wallets in the same
 * order and cannot deadlock.
 */
export async function postTransaction(tx: Tx, input: TransactionInput): Promise<number> {
  const entries = input.entries.filter((e) => e.amount !== 0n);
  const sum = entries.reduce((acc, e) => acc + e.amount, 0n);
  if (sum !== 0n) {
    throw new DomainError('unbalanced', `transaction ${input.kind} entries sum to ${sum}`);
  }

  const [row] = await tx
    .insert(transactions)
    .values({
      kind: input.kind,
      effectiveAt: input.effectiveAt,
      userId: input.userId ?? null,
      groupId: input.groupId ?? null,
      configVersionId: input.configVersionId ?? null,
      adminUserId: input.adminUserId ?? null,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: transactions.id });
  if (!row) throw new Error('transaction insert returned nothing');

  if (entries.length > 0) {
    const ordered = [...entries].sort((a, b) => a.walletId - b.walletId);
    await tx
      .insert(ledgerEntries)
      .values(
        ordered.map((e) => ({ transactionId: row.id, walletId: e.walletId, amount: e.amount })),
      );
  }
  return row.id;
}

export async function systemWalletId(ex: Executor, code: SystemWalletCode): Promise<number> {
  const [row] = await ex
    .select({ id: wallets.id })
    .from(wallets)
    .where(eq(wallets.systemCode, code));
  if (!row) throw new DomainError('missing_wallet', `system wallet ${code} is missing`);
  return row.id;
}

export interface WalletState {
  id: number;
  balance: bigint;
}

export async function userWallets(
  ex: Executor,
  userId: number,
): Promise<{ cash: WalletState; treasury: WalletState }> {
  const rows = await ex
    .select({ id: wallets.id, kind: wallets.kind, balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  const cash = rows.find((r) => r.kind === 'user_cash');
  const treasury = rows.find((r) => r.kind === 'user_treasury');
  if (!cash || !treasury) throw new DomainError('missing_wallet', `user ${userId} has no wallets`);
  return {
    cash: { id: cash.id, balance: cash.balance },
    treasury: { id: treasury.id, balance: treasury.balance },
  };
}

export async function groupBloodBankWallet(ex: Executor, groupId: number): Promise<WalletState> {
  const [row] = await ex
    .select({ id: wallets.id, balance: wallets.balance })
    .from(wallets)
    .where(and(eq(wallets.groupId, groupId), eq(wallets.kind, 'group_blood_bank')));
  if (!row) throw new DomainError('missing_wallet', `group ${groupId} has no blood bank`);
  return row;
}

/** The transaction already recorded for an idempotency key, if any. */
export async function findTransactionByKey(ex: Executor, key: string) {
  const [row] = await ex.select().from(transactions).where(eq(transactions.idempotencyKey, key));
  return row;
}
