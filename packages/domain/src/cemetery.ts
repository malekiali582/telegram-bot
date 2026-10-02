import { cemeteries, inTransaction } from '@lulu/database';
import { eq } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findTransactionByKey, postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction } from './players.ts';
import { CEMETERY_DENOMINATOR, cemeteryRateNumerator } from './settlement.ts';

const MS_PER_HOUR = 3_600_000n;

/** Hourly income in centi (rounded down for display; accrual itself is exact). */
function hourlyIncomeCenti(base: number, bonusBp: number, level: number): bigint {
  return (cemeteryRateNumerator(base, bonusBp, level) * MS_PER_HOUR) / CEMETERY_DENOMINATOR;
}

export type CemeteryView =
  | { status: 'closed'; openCostCenti: bigint; cashCenti: bigint }
  | {
      status: 'open';
      level: number;
      maxLevel: number;
      hourlyIncomeCenti: bigint;
      nextUpgradeCostCenti: bigint | null;
      cashCenti: bigint;
    }
  | { status: 'banned' };

/** «قبرستون»: state after settling income up to now. */
export async function cemeteryView(ctx: DomainContext, userId: number): Promise<CemeteryView> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, userId, now);
    if (player.banned) return { status: 'banned' };
    const { cash } = await userWallets(tx, userId);
    const [row] = await tx.select().from(cemeteries).where(eq(cemeteries.userId, userId));
    const c = config.cemetery;
    if (!row)
      return {
        status: 'closed',
        openCostCenti: pointsToCenti(c.openCost),
        cashCenti: cash.balance,
      };
    const nextCost = c.upgradeCosts[row.level];
    return {
      status: 'open',
      level: row.level,
      maxLevel: c.maxLevel,
      hourlyIncomeCenti: hourlyIncomeCenti(c.baseHourlyIncome, c.levelBonusBp, row.level),
      nextUpgradeCostCenti:
        row.level < c.maxLevel && nextCost !== undefined ? pointsToCenti(nextCost) : null,
      cashCenti: cash.balance,
    };
  });
}

export type OpenCemeteryResult =
  | { status: 'ok'; costCenti: bigint; cashCenti: bigint }
  | { status: 'already_open' }
  | { status: 'insufficient_funds'; costCenti: bigint; cashCenti: bigint }
  | { status: 'duplicate' }
  | { status: 'banned' };

/** Opens a level-0 cemetery for the fixed opening cost; income starts accruing now. */
export async function openCemetery(
  ctx: DomainContext,
  input: { userId: number; idempotencyKey?: string },
): Promise<OpenCemeteryResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    const [existing] = await tx
      .select()
      .from(cemeteries)
      .where(eq(cemeteries.userId, input.userId));
    if (existing) return { status: 'already_open' };

    const costCenti = pointsToCenti(config.cemetery.openCost);
    const { cash } = await userWallets(tx, input.userId);
    if (cash.balance < costCenti)
      return { status: 'insufficient_funds', costCenti, cashCenti: cash.balance };

    await postTransaction(tx, {
      kind: 'cemetery_open',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [
        { walletId: cash.id, amount: -costCenti },
        { walletId: await systemWalletId(tx, 'burn:cemetery'), amount: costCenti },
      ],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await tx.insert(cemeteries).values({
      userId: input.userId,
      level: 0,
      openedAt: now,
      accruedUntil: now,
      accrualRemainder: 0n,
      configVersionId: versionId,
      updatedAt: now,
    });
    return { status: 'ok', costCenti, cashCenti: cash.balance - costCenti };
  });
}

export type UpgradeCemeteryResult =
  | { status: 'ok'; newLevel: number; costCenti: bigint; cashCenti: bigint }
  | { status: 'not_open' }
  | { status: 'stale'; currentLevel: number }
  | { status: 'max_level'; currentLevel: number }
  | { status: 'insufficient_funds'; costCenti: bigint; cashCenti: bigint }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * Raises the cemetery one level (max 3). Income up to now has already been settled at
 * the old level by `beginPlayerAction`; the new rate applies from this instant.
 */
export async function upgradeCemetery(
  ctx: DomainContext,
  input: { userId: number; expectedLevel: number; idempotencyKey?: string },
): Promise<UpgradeCemeteryResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    const [row] = await tx.select().from(cemeteries).where(eq(cemeteries.userId, input.userId));
    if (!row) return { status: 'not_open' };
    if (row.level !== input.expectedLevel) return { status: 'stale', currentLevel: row.level };
    const cost = config.cemetery.upgradeCosts[row.level];
    if (row.level >= config.cemetery.maxLevel || cost === undefined) {
      return { status: 'max_level', currentLevel: row.level };
    }

    const costCenti = pointsToCenti(cost);
    const { cash } = await userWallets(tx, input.userId);
    if (cash.balance < costCenti)
      return { status: 'insufficient_funds', costCenti, cashCenti: cash.balance };

    await postTransaction(tx, {
      kind: 'cemetery_upgrade',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [
        { walletId: cash.id, amount: -costCenti },
        { walletId: await systemWalletId(tx, 'burn:cemetery'), amount: costCenti },
      ],
      metadata: { fromLevel: row.level, toLevel: row.level + 1 },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await tx
      .update(cemeteries)
      .set({ level: row.level + 1, updatedAt: now })
      .where(eq(cemeteries.userId, input.userId));
    return {
      status: 'ok',
      newLevel: row.level + 1,
      costCenti,
      cashCenti: cash.balance - costCenti,
    };
  });
}
