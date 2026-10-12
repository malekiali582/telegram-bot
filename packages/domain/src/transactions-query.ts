import { queryRows } from '@lulu/database';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { addDays, tehranMidnight } from './tehran.ts';

/**
 * Transaction history for the admin panel and its CSV export. Read-only.
 *
 * - A transaction "involves" a player when the player started it or any of its entries
 *   moved the player's cash or treasury (e.g. a ghost reward paid to every member).
 *   The same for a group: started there, or it moved the group's blood bank.
 * - Amount = the money it moved: the sum of its positive entries (0 for records such as
 *   a hunt attempt). With a player filter, `playerDeltaCenti` is that player's net change.
 * - Days are Tehran calendar days, inclusive.
 * - Newest first, paged by (effective time, id), so pages never skip or repeat rows
 *   while new transactions arrive.
 */

export interface TransactionFilter {
  userId?: number;
  groupId?: number;
  kinds?: string[];
  /** Tehran calendar days `YYYY-MM-DD`, inclusive. */
  fromDay?: string;
  toDay?: string;
  minCenti?: bigint;
  maxCenti?: bigint;
}

export interface TransactionCursor {
  effectiveAt: Date;
  id: number;
}

export interface TransactionEntryView {
  walletKind: 'user_cash' | 'user_treasury' | 'group_blood_bank' | 'system';
  userId: number | null;
  groupId: number | null;
  systemCode: string | null;
  amountCenti: bigint;
}

export interface TransactionItem {
  id: number;
  kind: string;
  effectiveAt: Date;
  recordedAt: Date;
  /** Display texts are untrusted. */
  user: { id: number; displayName: string } | null;
  group: { id: number; title: string } | null;
  admin: { id: number; username: string } | null;
  reason: string | null;
  amountCenti: bigint;
  /** Net change of the filtered player's cash + treasury. */
  playerDeltaCenti: bigint | null;
  entries: TransactionEntryView[];
}

function conditions(f: TransactionFilter): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.userId !== undefined) {
    parts.push(sql`t.id IN (
      SELECT id FROM transactions WHERE user_id = ${f.userId}
      UNION
      SELECT le.transaction_id FROM ledger_entries le
      WHERE le.wallet_id IN (SELECT id FROM wallets WHERE user_id = ${f.userId}))`);
  }
  if (f.groupId !== undefined) {
    parts.push(sql`t.id IN (
      SELECT id FROM transactions WHERE group_id = ${f.groupId}
      UNION
      SELECT le.transaction_id FROM ledger_entries le
      WHERE le.wallet_id IN (SELECT id FROM wallets WHERE group_id = ${f.groupId}))`);
  }
  if (f.kinds?.length) {
    parts.push(
      sql`t.kind IN (${sql.join(
        f.kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  }
  if (f.fromDay) {
    parts.push(sql`t.effective_at >= ${tehranMidnight(f.fromDay).toISOString()}::timestamptz`);
  }
  if (f.toDay) {
    const end = tehranMidnight(addDays(f.toDay, 1)).toISOString();
    parts.push(sql`t.effective_at < ${end}::timestamptz`);
  }
  return sql.join(parts, sql` AND `);
}

/** Inner query with the gross amount; the amount filter applies to its result. */
function filtered(f: TransactionFilter, extra: SQL = sql`true`): SQL {
  const amount: SQL[] = [sql`true`];
  if (f.minCenti !== undefined) amount.push(sql`x.gross >= ${f.minCenti.toString()}::numeric`);
  if (f.maxCenti !== undefined) amount.push(sql`x.gross <= ${f.maxCenti.toString()}::numeric`);
  return sql`(SELECT * FROM (
      SELECT t.*,
             (SELECT coalesce(sum(le.amount), 0) FROM ledger_entries le
               WHERE le.transaction_id = t.id AND le.amount > 0) AS gross
      FROM transactions t
      WHERE ${conditions(f)} AND ${extra}) x
    WHERE ${sql.join(amount, sql` AND `)})`;
}

type Row = {
  id: number | string;
  kind: string;
  effective_at: Date;
  recorded_at: Date;
  user_id: number | string | null;
  display_name: string | null;
  group_id: number | string | null;
  title: string | null;
  admin_user_id: number | string | null;
  admin_username: string | null;
  reason: string | null;
  gross: string;
  player_delta: string | null;
};

async function page(
  ctx: DomainContext,
  filter: TransactionFilter,
  limit: number,
  after: TransactionCursor | undefined,
): Promise<TransactionItem[]> {
  const cursor = after
    ? sql`(t.effective_at, t.id) < (${after.effectiveAt.toISOString()}::timestamptz, ${after.id})`
    : sql`true`;
  const delta =
    filter.userId !== undefined
      ? sql`(SELECT coalesce(sum(le.amount), 0)::text FROM ledger_entries le
              JOIN wallets w ON w.id = le.wallet_id
             WHERE le.transaction_id = x.id AND w.user_id = ${filter.userId})`
      : sql`NULL`;
  const rows = await queryRows<Row>(
    ctx.db,
    sql`SELECT x.id, x.kind, x.effective_at, x.recorded_at, x.user_id, u.display_name,
               x.group_id, g.title, x.admin_user_id, a.username AS admin_username, x.reason,
               x.gross::text AS gross, ${delta} AS player_delta
        FROM ${filtered(filter, cursor)} x
        LEFT JOIN users u ON u.id = x.user_id
        LEFT JOIN groups g ON g.id = x.group_id
        LEFT JOIN admin_users a ON a.id = x.admin_user_id
        ORDER BY x.effective_at DESC, x.id DESC
        LIMIT ${limit}`,
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => Number(r.id));
  const entries = await queryRows<{
    transaction_id: number | string;
    kind: TransactionEntryView['walletKind'];
    user_id: number | string | null;
    group_id: number | string | null;
    system_code: string | null;
    amount: string;
  }>(
    ctx.db,
    sql`SELECT le.transaction_id, w.kind, w.user_id, w.group_id, w.system_code, le.amount::text
        FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
        WHERE le.transaction_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY le.transaction_id, le.id`,
  );
  const byTx = new Map<number, TransactionEntryView[]>();
  for (const e of entries) {
    const list = byTx.get(Number(e.transaction_id)) ?? [];
    list.push({
      walletKind: e.kind,
      userId: e.user_id === null ? null : Number(e.user_id),
      groupId: e.group_id === null ? null : Number(e.group_id),
      systemCode: e.system_code,
      amountCenti: BigInt(e.amount),
    });
    byTx.set(Number(e.transaction_id), list);
  }

  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    effectiveAt: new Date(r.effective_at),
    recordedAt: new Date(r.recorded_at),
    user: r.user_id === null ? null : { id: Number(r.user_id), displayName: r.display_name ?? '' },
    group: r.group_id === null ? null : { id: Number(r.group_id), title: r.title ?? '' },
    admin:
      r.admin_user_id === null
        ? null
        : { id: Number(r.admin_user_id), username: r.admin_username ?? '' },
    reason: r.reason,
    amountCenti: BigInt(r.gross),
    playerDeltaCenti: r.player_delta === null ? null : BigInt(r.player_delta),
    entries: byTx.get(Number(r.id)) ?? [],
  }));
}

export async function listTransactions(
  ctx: DomainContext,
  filter: TransactionFilter,
  options: { limit: number; after?: TransactionCursor },
): Promise<{ items: TransactionItem[]; next: TransactionCursor | null }> {
  const items = await page(ctx, filter, options.limit + 1, options.after);
  const more = items.length > options.limit;
  const shown = more ? items.slice(0, options.limit) : items;
  const last = shown.at(-1);
  return {
    items: shown,
    next: more && last ? { effectiveAt: last.effectiveAt, id: last.id } : null,
  };
}

/** How many transactions match, and how much money they moved in total. */
export async function summarizeTransactions(
  ctx: DomainContext,
  filter: TransactionFilter,
): Promise<{ count: number; amountCenti: bigint }> {
  const [row] = await queryRows<{ n: number; total: string }>(
    ctx.db,
    sql`SELECT count(*)::int AS n, coalesce(sum(x.gross), 0)::text AS total
        FROM ${filtered(filter)} x`,
  );
  return { count: row?.n ?? 0, amountCenti: BigInt(row?.total ?? '0') };
}

/** Every matching transaction, newest first, in batches (CSV export). */
export async function* allTransactions(
  ctx: DomainContext,
  filter: TransactionFilter,
  batchSize = 500,
): AsyncGenerator<TransactionItem> {
  let after: TransactionCursor | undefined;
  for (;;) {
    const result = await listTransactions(ctx, filter, {
      limit: batchSize,
      ...(after ? { after } : {}),
    });
    yield* result.items;
    if (!result.next) return;
    after = result.next;
  }
}
