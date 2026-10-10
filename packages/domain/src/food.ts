import type { FoodKind } from '@lulu/config';
import { foodEffects, inTransaction, inventory } from '@lulu/database';
import type { Tx } from '@lulu/database';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findTransactionByKey, postTransaction } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction } from './players.ts';

export async function activeMealCount(tx: Tx, userId: number, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(foodEffects)
    .where(and(eq(foodEffects.userId, userId), gt(foodEffects.expiresAt, now)));
  return row?.n ?? 0;
}

export type EatResult =
  | {
      status: 'ok';
      food: FoodKind;
      count: number;
      startedAt: Date;
      expiresAt: Date;
      activeMeals: number;
      capacity: number;
      /** Points per deposit for one meal; every meal of this request pays the same. */
      pointsPerDeposit: number;
      depositsTotal: number;
      depositIntervalSeconds: number;
    }
  | { status: 'not_enough_food'; food: FoodKind; have: number; requested: number }
  | { status: 'capacity_exceeded'; active: number; capacity: number; requested: number }
  | { status: 'invalid_count' }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * Eats `count` items: each becomes an independent meal active for the configured
 * duration, paying the food's fixed amount into cash at the end of every deposit
 * interval (see settleFood). The amount and schedule are fixed now, so a later config
 * change never alters a running meal. A request that would exceed the level's
 * simultaneous-meal capacity is rejected entirely; no running meal is ever replaced.
 */
export async function eat(
  ctx: DomainContext,
  input: { userId: number; food: FoodKind; count: number; idempotencyKey?: string },
): Promise<EatResult> {
  if (!Number.isSafeInteger(input.count) || input.count < 1) return { status: 'invalid_count' };
  const now = ctx.clock.now();

  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }

    const capacity = config.levels[player.level - 1]?.mealCapacity ?? 0;
    const active = await activeMealCount(tx, input.userId, now);
    if (active + input.count > capacity) {
      return { status: 'capacity_exceeded', active, capacity, requested: input.count };
    }

    const [stock] = await tx
      .select({ quantity: inventory.quantity })
      .from(inventory)
      .where(and(eq(inventory.userId, input.userId), eq(inventory.food, input.food)));
    const have = stock?.quantity ?? 0;
    if (have < input.count) {
      return { status: 'not_enough_food', food: input.food, have, requested: input.count };
    }

    await tx
      .update(inventory)
      .set({ quantity: sql`${inventory.quantity} - ${input.count}` })
      .where(and(eq(inventory.userId, input.userId), eq(inventory.food, input.food)));

    const { nutrition, pointsPerDeposit } = config.foods[input.food];
    const { mealDurationSeconds, depositIntervalSeconds } = config.food;
    const depositsTotal = mealDurationSeconds / depositIntervalSeconds;
    const expiresAt = new Date(now.getTime() + mealDurationSeconds * 1000);
    await tx.insert(foodEffects).values(
      Array.from({ length: input.count }, () => ({
        userId: input.userId,
        food: input.food,
        nutrition,
        startedAt: now,
        expiresAt,
        createdAt: now,
        depositCenti: pointsToCenti(pointsPerDeposit),
        depositIntervalSeconds,
        depositsTotal,
      })),
    );
    await postTransaction(tx, {
      kind: 'eat',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [],
      metadata: { food: input.food, count: input.count, pointsPerDeposit, depositsTotal },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });

    return {
      status: 'ok',
      food: input.food,
      count: input.count,
      startedAt: now,
      expiresAt,
      activeMeals: active + input.count,
      capacity,
      pointsPerDeposit,
      depositsTotal,
      depositIntervalSeconds,
    };
  });
}
