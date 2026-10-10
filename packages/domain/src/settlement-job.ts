import { inTransaction, queryRows, wallets } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { beginPlayerAction } from './players.ts';
import { tehranDate } from './tehran.ts';

// ───────────────────────── worker entry point ─────────────────────────

/**
 * One batch of the periodic settlement job: players with a cemetery, with a treasury
 * balance and an unsettled midnight, with a food deposit that has come due, or with a
 * finished streak day not yet paid.
 * Keyset-paged by user id. Safe to run late, twice, or alongside player actions (same
 * lock, same idempotent settlement).
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
                                       OR p.interest_settled_through < ${today}::date))
               OR EXISTS (SELECT 1 FROM food_effects f
                          WHERE f.user_id = p.user_id AND f.deposits_paid < f.deposits_total
                            AND f.started_at + make_interval(
                                  secs => f.deposit_interval_seconds * (f.deposits_paid + 1))
                                <= ${now.toISOString()}::timestamptz)
               OR EXISTS (SELECT 1 FROM streak_days s
                          WHERE s.user_id = p.user_id AND s.tehran_date < ${today}::date
                            AND (p.streak_settled_through IS NULL
                                 OR s.tehran_date > p.streak_settled_through)))
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
