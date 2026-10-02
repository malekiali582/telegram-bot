import { inTransaction, playerState } from '@lulu/database';
import { eq } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findTransactionByKey, postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction } from './players.ts';

export type LevelUpgradePreview =
  | {
      status: 'ok';
      currentLevel: number;
      nextLevel: number;
      costCenti: bigint;
      cashCenti: bigint;
      affordable: boolean;
    }
  | { status: 'max_level'; currentLevel: number }
  | { status: 'banned' };

/** What «ارتقای لولو» would cost; shown before the player confirms. */
export async function previewLevelUpgrade(
  ctx: DomainContext,
  userId: number,
): Promise<LevelUpgradePreview> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, userId, now);
    if (player.banned) return { status: 'banned' };
    const cost = config.levels[player.level - 1]?.upgradeCost ?? null;
    if (cost === null) return { status: 'max_level', currentLevel: player.level };
    const { cash } = await userWallets(tx, userId);
    const costCenti = pointsToCenti(cost);
    return {
      status: 'ok',
      currentLevel: player.level,
      nextLevel: player.level + 1,
      costCenti,
      cashCenti: cash.balance,
      affordable: cash.balance >= costCenti,
    };
  });
}

export type LevelUpgradeResult =
  | { status: 'ok'; newLevel: number; costCenti: bigint; cashCenti: bigint; transactionId: number }
  /** The confirmation was for another level (already upgraded, e.g. a double click). */
  | { status: 'stale'; currentLevel: number }
  | { status: 'max_level'; currentLevel: number }
  | { status: 'insufficient_funds'; costCenti: bigint; cashCenti: bigint }
  | { status: 'duplicate'; transactionId: number }
  | { status: 'banned' };

/**
 * Buys exactly the next level, paid from cash only (never from the treasury).
 * `expectedLevel` binds the confirmation to the level shown, so a repeated or
 * concurrent confirmation upgrades at most once. Cooldowns and meals are untouched.
 */
export async function upgradeLevel(
  ctx: DomainContext,
  input: { userId: number; expectedLevel: number; idempotencyKey?: string },
): Promise<LevelUpgradeResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey) {
      const previous = await findTransactionByKey(tx, input.idempotencyKey);
      if (previous) return { status: 'duplicate', transactionId: previous.id };
    }
    if (player.level !== input.expectedLevel) {
      return { status: 'stale', currentLevel: player.level };
    }
    const cost = config.levels[player.level - 1]?.upgradeCost ?? null;
    if (cost === null) return { status: 'max_level', currentLevel: player.level };

    const costCenti = pointsToCenti(cost);
    const { cash } = await userWallets(tx, input.userId);
    if (cash.balance < costCenti) {
      return { status: 'insufficient_funds', costCenti, cashCenti: cash.balance };
    }

    const newLevel = player.level + 1;
    const transactionId = await postTransaction(tx, {
      kind: 'level_upgrade',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [
        { walletId: cash.id, amount: -costCenti },
        { walletId: await systemWalletId(tx, 'burn:level_upgrade'), amount: costCenti },
      ],
      metadata: { fromLevel: player.level, toLevel: newLevel },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await tx
      .update(playerState)
      .set({ level: newLevel, updatedAt: now })
      .where(eq(playerState.userId, input.userId));

    return {
      status: 'ok',
      newLevel,
      costCenti,
      cashCenti: cash.balance - costCenti,
      transactionId,
    };
  });
}
