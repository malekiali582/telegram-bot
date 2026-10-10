import { BP_SCALE, CENTI_PER_POINT } from '@lulu/config';
import type { Tx } from '@lulu/database';
import {
  cemeteries,
  configVersions,
  foodEffects,
  interestSettlements,
  playerState,
  queryRows,
} from '@lulu/database';
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { addDays, tehranDate, tehranMidnight } from './tehran.ts';

/**
 * Lazy settlement, run under the player lock before every player action and by the
 * worker. Every part depends only on stored state and effective times, never on when
 * the code happens to run, so late, repeated or concurrent runs change nothing.
 */

// ───────────────────────── treasury interest ─────────────────────────

/** Treasury balance as of an instant: entries whose transaction is effective before it. */
async function treasuryBalanceBefore(tx: Tx, walletId: number, instant: Date): Promise<bigint> {
  const [row] = await queryRows<{ total: string }>(
    tx,
    sql`SELECT coalesce(sum(e.amount), 0)::text AS total
        FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.wallet_id = ${walletId} AND t.effective_at < ${instant.toISOString()}::timestamptz`,
  );
  return BigInt(row?.total ?? '0');
}

async function hasTreasuryEntriesSince(tx: Tx, walletId: number, instant: Date): Promise<boolean> {
  const rows = await queryRows<{ one: number }>(
    tx,
    sql`SELECT 1 AS one FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.wallet_id = ${walletId} AND t.effective_at >= ${instant.toISOString()}::timestamptz
        LIMIT 1`,
  );
  return rows.length > 0;
}

export interface InterestSettlementResult {
  boundaries: string[];
  interestCenti: bigint;
}

/**
 * Applies every Tehran midnight since the last one settled, in order. Each midnight
 * pays floor(balance × rate) on the treasury balance *as of that midnight* (by
 * effective time), into the treasury itself — compound interest. The rate is the
 * one in force at that midnight. A transaction effective exactly at midnight belongs
 * to the new day, so it neither earns nor forfeits that night's interest.
 * `interest_settlements (user, date)` makes a second payment for a night impossible.
 */
export async function settleInterest(
  tx: Tx,
  ctx: DomainContext,
  player: { userId: number; startedAt: Date; interestSettledThrough: string | null },
  now: Date,
): Promise<InterestSettlementResult> {
  const result: InterestSettlementResult = { boundaries: [], interestCenti: 0n };
  const settledThrough = player.interestSettledThrough ?? tehranDate(player.startedAt);
  const latestDue = tehranDate(now); // its midnight is <= now
  let date = addDays(settledThrough, 1);
  if (date > latestDue) return result;

  const { treasury } = await userWallets(tx, player.userId);
  const firstMidnight = tehranMidnight(date);
  const idle =
    treasury.balance === 0n && !(await hasTreasuryEntriesSince(tx, treasury.id, firstMidnight));

  if (!idle) {
    for (; date <= latestDue; date = addDays(date, 1)) {
      const midnight = tehranMidnight(date);
      const balanceBefore = await treasuryBalanceBefore(tx, treasury.id, midnight);
      result.boundaries.push(date);
      if (balanceBefore <= 0n) continue;

      const { versionId, config } = await ctx.config.effectiveAt(tx, midnight);
      const rateBp = config.treasury.dailyInterestBp;
      const interest = (balanceBefore * BigInt(rateBp)) / BigInt(BP_SCALE);
      const transactionId =
        interest > 0n
          ? await postTransaction(tx, {
              kind: 'interest',
              effectiveAt: midnight,
              userId: player.userId,
              configVersionId: versionId,
              idempotencyKey: `interest:${player.userId}:${date}`,
              entries: [
                { walletId: await systemWalletId(tx, 'mint:interest'), amount: -interest },
                { walletId: treasury.id, amount: interest },
              ],
              metadata: { boundaryDate: date, balanceBefore: balanceBefore.toString(), rateBp },
            })
          : null;
      await tx.insert(interestSettlements).values({
        userId: player.userId,
        boundaryDate: date,
        balanceBefore,
        interest,
        rateBp,
        transactionId,
        createdAt: now,
      });
      result.interestCenti += interest;
    }
  }

  await tx
    .update(playerState)
    .set({ interestSettledThrough: latestDue })
    .where(eq(playerState.userId, player.userId));
  return result;
}

// ───────────────────────── cemetery income ─────────────────────────

const MS_PER_HOUR = 3_600_000n;
/** accrual_remainder is in units of 1 / CEMETERY_DENOMINATOR centi. */
export const CEMETERY_DENOMINATOR = BigInt(BP_SCALE) * MS_PER_HOUR;

/** Income numerator per ms, in remainder units: base × 100 × (10 000 + bonus × level). */
export function cemeteryRateNumerator(
  baseHourlyIncome: number,
  levelBonusBp: number,
  level: number,
): bigint {
  return BigInt(baseHourlyIncome) * CENTI_PER_POINT * BigInt(BP_SCALE + levelBonusBp * level);
}

export interface CemeterySettlementResult {
  creditedCenti: bigint;
}

/**
 * Credits cemetery income from `accrued_until` to `now` straight into cash. Time is
 * cut at every configuration change so each stretch uses the rate in force then; the
 * fraction below one centi is carried in `accrual_remainder`, so nothing is lost and
 * nothing is paid twice, however often (or rarely) this runs.
 */
export async function settleCemetery(
  tx: Tx,
  ctx: DomainContext,
  userId: number,
  now: Date,
): Promise<CemeterySettlementResult> {
  const [cemetery] = await tx.select().from(cemeteries).where(eq(cemeteries.userId, userId));
  if (!cemetery || cemetery.accruedUntil.getTime() >= now.getTime()) return { creditedCenti: 0n };

  const changes = await tx
    .select({ effectiveFrom: configVersions.effectiveFrom })
    .from(configVersions)
    .where(
      and(
        gt(configVersions.effectiveFrom, cemetery.accruedUntil),
        lte(configVersions.effectiveFrom, now),
      ),
    )
    .orderBy(asc(configVersions.effectiveFrom));
  const cuts = [cemetery.accruedUntil, ...changes.map((c) => c.effectiveFrom), now];

  let numerator = cemetery.accrualRemainder;
  let versionId = cemetery.configVersionId;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    if (to.getTime() <= from.getTime()) continue;
    const effective = await ctx.config.effectiveAt(tx, from);
    versionId = effective.versionId;
    const { baseHourlyIncome, levelBonusBp } = effective.config.cemetery;
    numerator +=
      cemeteryRateNumerator(baseHourlyIncome, levelBonusBp, cemetery.level) *
      BigInt(to.getTime() - from.getTime());
  }
  const credited = numerator / CEMETERY_DENOMINATOR;
  const remainder = numerator % CEMETERY_DENOMINATOR;

  if (credited > 0n) {
    const { cash } = await userWallets(tx, userId);
    await postTransaction(tx, {
      kind: 'cemetery_income',
      effectiveAt: now,
      userId,
      ...(versionId !== null ? { configVersionId: versionId } : {}),
      entries: [
        { walletId: await systemWalletId(tx, 'mint:cemetery'), amount: -credited },
        { walletId: cash.id, amount: credited },
      ],
      metadata: {
        from: cemetery.accruedUntil.toISOString(),
        to: now.toISOString(),
        level: cemetery.level,
      },
    });
  }
  await tx
    .update(cemeteries)
    .set({
      accruedUntil: now,
      accrualRemainder: remainder,
      configVersionId: versionId,
      updatedAt: now,
    })
    .where(eq(cemeteries.userId, userId));
  return { creditedCenti: credited };
}

// ───────────────────────── food deposits ─────────────────────────

export interface MealSchedule {
  startedAt: Date;
  depositIntervalSeconds: number;
  depositsTotal: number;
}

/**
 * Deposits a meal has earned by `now`: one at the end of every whole interval since it
 * was eaten (at +5, +10 … +30 minutes), at most `depositsTotal`. A deposit is due at
 * exactly its instant.
 */
export function depositsDue(meal: MealSchedule, now: Date): number {
  const elapsed = now.getTime() - meal.startedAt.getTime();
  if (elapsed <= 0) return 0;
  return Math.min(meal.depositsTotal, Math.floor(elapsed / (meal.depositIntervalSeconds * 1000)));
}

export interface FoodSettlementResult {
  creditedCenti: bigint;
  deposits: number;
}

/**
 * Pays every food deposit that has come due into cash, in one ledger transaction.
 * `deposits_paid` records progress per meal, so no deposit is paid twice and none is
 * lost however late this runs. Fully paid meals have ended and are removed.
 */
export async function settleFood(tx: Tx, userId: number, now: Date): Promise<FoodSettlementResult> {
  const meals = await tx
    .select()
    .from(foodEffects)
    .where(
      and(
        eq(foodEffects.userId, userId),
        lt(foodEffects.depositsPaid, foodEffects.depositsTotal),
        lte(foodEffects.startedAt, now),
      ),
    )
    .orderBy(asc(foodEffects.id));

  let credited = 0n;
  let deposits = 0;
  const paid: { meal: number; food: string; deposits: number }[] = [];
  for (const meal of meals) {
    const due = depositsDue(meal, now);
    const count = due - meal.depositsPaid;
    if (count <= 0) continue;
    credited += meal.depositCenti * BigInt(count);
    deposits += count;
    paid.push({ meal: meal.id, food: meal.food, deposits: count });
    await tx.update(foodEffects).set({ depositsPaid: due }).where(eq(foodEffects.id, meal.id));
  }

  if (credited > 0n) {
    const { cash } = await userWallets(tx, userId);
    await postTransaction(tx, {
      kind: 'food_income',
      effectiveAt: now,
      userId,
      entries: [
        { walletId: await systemWalletId(tx, 'mint:food'), amount: -credited },
        { walletId: cash.id, amount: credited },
      ],
      metadata: { meals: paid },
    });
  }
  await tx
    .delete(foodEffects)
    .where(
      and(
        eq(foodEffects.userId, userId),
        sql`${foodEffects.depositsPaid} = ${foodEffects.depositsTotal}`,
        lte(foodEffects.expiresAt, now),
      ),
    );
  return { creditedCenti: credited, deposits };
}
