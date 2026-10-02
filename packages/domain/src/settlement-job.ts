import { inTransaction, queryRows, wallets } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { beginPlayerAction } from './players.ts';
import { tehranDate } from './tehran.ts';

// ───────────────────────── worker entry point ─────────────────────────

/**
 * One batch of the periodic settlement job: players with a cemetery, or with a
 * treasury balance and an unsettled midnight. Keyset-paged by user id. Safe to run
 * late, twice, or alongside player actions (same lock, same idempotent settlement).
 */
export async function settleDuePlayers(
  ctx: DomainContext,
  options: { afterUserId?: number; limit?: number } = {},
): Promise<{ settled: number; lastUserId: number | undefined }> {
  const now = ctx.clock.now();
  const today = tehranDate(now);
  const after = options.afterUserId ?? 0;
  const limit = options.limit ?? 200;

  const due = await queryRows<{ user_id: string | number }>(
    ctx.db,
    sql`SELECT p.user_id FROM player_state p
        LEFT JOIN cemeteries c ON c.user_id = p.user_id
        LEFT JOIN ${wallets} w ON w.user_id = p.user_id AND w.kind = 'user_treasury'
        WHERE p.user_id > ${after}
          AND (c.accrued_until < ${now.toISOString()}::timestamptz
               OR (w.balance > 0 AND (p.interest_settled_through IS NULL
                                       OR p.interest_settled_through < ${today}::date)))
        ORDER BY p.user_id
        LIMIT ${limit}`,
  );

  let lastUserId: number | undefined;
  for (const row of due) {
    const userId = Number(row.user_id);
    await inTransaction(ctx.db, (tx) => beginPlayerAction(tx, ctx, userId, now));
    lastUserId = userId;
  }
  return { settled: due.length, lastUserId };
}
