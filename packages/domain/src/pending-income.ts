import type { GameConfig } from '@lulu/config';
import { BP_SCALE, CENTI_PER_POINT } from '@lulu/config';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { CEMETERY_DENOMINATOR } from './settlement.ts';

/**
 * Income an idle player has earned but the worker has not settled yet: cemetery income
 * since `accrued_until` and food deposits that have come due. Read-only, for displays
 * that rank or total balances (leaderboard, dashboard) between the worker's hourly
 * settlements. The figure equals what settlement would credit at `now`, except when the
 * cemetery configuration changed inside that window (settlement splits the time at the
 * change; this uses the current rate).
 *
 * A derived table `(user_id, pending)` in centi-points.
 */
export function pendingIncome(config: GameConfig, now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  const { baseHourlyIncome, levelBonusBp } = config.cemetery;
  // Same arithmetic as settleCemetery: numerator per ms in 1 / CEMETERY_DENOMINATOR centi.
  const rate = sql`(${BigInt(baseHourlyIncome) * CENTI_PER_POINT}::numeric
                    * (${BP_SCALE} + ${levelBonusBp} * c.level))`;
  const elapsedMs = (from: SQL) => sql`floor(extract(epoch FROM (${at} - ${from})) * 1000)`;
  return sql`(
    SELECT user_id, sum(pending) AS pending FROM (
      SELECT c.user_id,
             div(c.accrual_remainder + ${rate} * ${elapsedMs(sql`c.accrued_until`)},
                 ${CEMETERY_DENOMINATOR.toString()}::numeric) AS pending
      FROM cemeteries c
      WHERE c.accrued_until < ${at}
      UNION ALL
      SELECT f.user_id,
             f.deposit_centi * (least(f.deposits_total,
                                      floor(${elapsedMs(sql`f.started_at`)}
                                            / (f.deposit_interval_seconds * 1000)))
                                - f.deposits_paid) AS pending
      FROM food_effects f
      WHERE f.started_at <= ${at} AND f.deposits_paid < f.deposits_total
    ) parts
    WHERE pending > 0
    GROUP BY user_id)`;
}
