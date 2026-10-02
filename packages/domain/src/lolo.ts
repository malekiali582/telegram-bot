import { foodEffects, inTransaction, playerState } from '@lulu/database';
import { and, eq, lte } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { DomainError } from './context.ts';
import {
  claimWaitNotice,
  cooldownAvailableAt,
  effectiveCooldownSeconds,
  isCoolingDown,
  startCooldown,
} from './cooldowns.ts';
import { foodBonusPoints, foodWindowStart, mealsOverlapping } from './food.ts';
import { groupBuffs } from './groups.ts';
import { postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction, touchMembership } from './players.ts';

export type LoloResult =
  | {
      status: 'ok';
      basePoints: number;
      foodBonusPoints: bigint;
      cashCenti: bigint;
      nextAvailableAt: Date;
      transactionId: number;
    }
  | {
      status: 'cooldown';
      availableAt: Date;
      remainingMs: number;
      /** False when a "time remaining" reply was sent recently in this group. */
      notify: boolean;
    }
  | { status: 'banned' };

/**
 * «لولو» in a group. One shared cooldown across all groups (player lock + stored
 * availability). Pays a uniform random base reward for the level plus the food bonus
 * of the window since the last successful lolo (at most the claim window). A lolo
 * during the cooldown changes nothing, so it consumes no food bonus either.
 */
export async function claimLolo(
  ctx: DomainContext,
  input: { userId: number; groupId: number },
): Promise<LoloResult> {
  const now = ctx.clock.now();

  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, input.userId);
    if (player.banned) return { status: 'banned' };

    const availableAt = await cooldownAvailableAt(tx, input.userId, 'lolo');
    if (availableAt && isCoolingDown(availableAt, now)) {
      const notify = await claimWaitNotice(tx, {
        userId: input.userId,
        groupId: input.groupId,
        kind: 'lolo',
        now,
        throttleSeconds: config.lolo.waitNoticeThrottleSeconds,
      });
      return {
        status: 'cooldown',
        availableAt,
        remainingMs: availableAt.getTime() - now.getTime(),
        notify,
      };
    }

    const level = config.levels[player.level - 1];
    if (!level) throw new DomainError('bad_level', `no config for level ${player.level}`);
    const basePoints = ctx.rng.int(level.rewardMin, level.rewardMax);

    const windowStart = foodWindowStart(
      player.lastLoloAt,
      player.startedAt,
      now,
      config.food.claimWindowSeconds,
    );
    const meals = await mealsOverlapping(tx, input.userId, windowStart, now);
    const bonus = foodBonusPoints(meals, windowStart, now);

    const wallets = await userWallets(tx, input.userId);
    const baseCenti = pointsToCenti(basePoints);
    const bonusCenti = pointsToCenti(bonus);
    const transactionId = await postTransaction(tx, {
      kind: 'lolo_reward',
      effectiveAt: now,
      userId: input.userId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [
        { walletId: await systemWalletId(tx, 'mint:lolo'), amount: -baseCenti },
        { walletId: wallets.cash.id, amount: baseCenti },
        { walletId: await systemWalletId(tx, 'mint:food'), amount: -bonusCenti },
        { walletId: wallets.cash.id, amount: bonusCenti },
      ],
      metadata: {
        basePoints,
        foodBonusPoints: bonus.toString(),
        windowStart: windowStart.toISOString(),
      },
    });

    await tx
      .update(playerState)
      .set({ lastLoloAt: now, updatedAt: now })
      .where(eq(playerState.userId, input.userId));

    const buffs = await groupBuffs(tx, input.groupId);
    const effectiveSeconds = effectiveCooldownSeconds(
      config.lolo.cooldownSeconds,
      config.curses.lolo_echo.reductionPerLevelBp,
      buffs.loloEchoLevel,
    );
    const nextAvailableAt = await startCooldown(tx, {
      userId: input.userId,
      kind: 'lolo',
      now,
      groupId: input.groupId,
      baseSeconds: config.lolo.cooldownSeconds,
      effectiveSeconds,
    });
    await touchMembership(tx, input.groupId, input.userId, now, true);

    // Meals that ended by now can never overlap a future window (it starts at >= now).
    await tx
      .delete(foodEffects)
      .where(and(eq(foodEffects.userId, input.userId), lte(foodEffects.expiresAt, now)));

    return {
      status: 'ok',
      basePoints,
      foodBonusPoints: bonus,
      cashCenti: wallets.cash.balance + baseCenti + bonusCenti,
      nextAvailableAt,
      transactionId,
    };
  });
}
