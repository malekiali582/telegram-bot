import { BP_SCALE, FOOD_KINDS, TOOL_KINDS } from '@lulu/config';
import type { FoodKind, GameConfig, ToolKind } from '@lulu/config';
import { inTransaction, inventory } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { DomainContext, Rng } from './context.ts';
import {
  claimWaitNotice,
  cooldownAvailableAt,
  effectiveCooldownSeconds,
  isCoolingDown,
  startCooldown,
} from './cooldowns.ts';
import { groupBuffs } from './groups.ts';
import { postTransaction } from './ledger.ts';
import { beginPlayerAction, touchMembership } from './players.ts';

export interface HuntSituation {
  playerLevel: number;
  equippedTool: ToolKind | null;
  huntingGroundLevel: number;
}

/** Exact probability as a fraction, so tests can assert sums of exactly 1. */
export interface PreyProbability {
  food: FoodKind;
  numerator: bigint;
  denominator: bigint;
}

interface PreyPlan {
  /** Prey that need a special tool (human): keep their absolute table weight. */
  fixed: { food: FoodKind; weight: number }[];
  fixedSum: number;
  /** Everything else allowed: shares the remaining probability in table proportions. */
  rest: { food: FoodKind; weight: number }[];
  restSum: number;
}

function isAllowed(config: GameConfig, food: FoodKind, situation: HuntSituation): boolean {
  const rule = config.foods[food];
  if (situation.playerLevel < rule.minLevel) return false;
  return rule.requiredTool === null || rule.requiredTool === situation.equippedTool;
}

/**
 * Conditional prey distribution given a successful hunt (spec §8):
 * locked prey are removed; when human is not allowed its weight is dropped and the
 * rest is renormalized to 100 %; when it is allowed (level 6 + magic wand equipped)
 * its table probability is kept exactly and the others share the remainder.
 */
function preyPlan(config: GameConfig, situation: HuntSituation): PreyPlan {
  const ground = config.huntingGrounds[situation.huntingGroundLevel - 1];
  if (!ground) throw new RangeError(`no hunting ground level ${situation.huntingGroundLevel}`);
  const fixed: PreyPlan['fixed'] = [];
  const rest: PreyPlan['rest'] = [];
  for (const food of FOOD_KINDS) {
    const weight = ground.weightsBp[food];
    if (weight === 0 || !isAllowed(config, food, situation)) continue;
    (config.foods[food].requiredTool === null ? rest : fixed).push({ food, weight });
  }
  const sum = (items: { weight: number }[]) => items.reduce((acc, i) => acc + i.weight, 0);
  return { fixed, fixedSum: sum(fixed), rest, restSum: sum(rest) };
}

export function preyDistribution(config: GameConfig, situation: HuntSituation): PreyProbability[] {
  const plan = preyPlan(config, situation);
  const scale = BigInt(BP_SCALE);
  if (plan.restSum === 0) {
    const total = BigInt(plan.fixedSum);
    return plan.fixed.map((p) => ({
      food: p.food,
      numerator: BigInt(p.weight),
      denominator: total,
    }));
  }
  const remainder = scale - BigInt(plan.fixedSum);
  return [
    ...plan.fixed.map((p) => ({ food: p.food, numerator: BigInt(p.weight), denominator: scale })),
    ...plan.rest.map((p) => ({
      food: p.food,
      numerator: remainder * BigInt(p.weight),
      denominator: scale * BigInt(plan.restSum),
    })),
  ];
}

function pickWeighted(items: { food: FoodKind; weight: number }[], roll: number): FoodKind {
  let acc = 0;
  for (const item of items) {
    acc += item.weight;
    if (roll < acc) return item.food;
  }
  throw new RangeError('roll outside the weight range');
}

/** Samples exactly `preyDistribution`: one roll for the fixed prey, one among the rest. */
export function pickPrey(config: GameConfig, situation: HuntSituation, rng: Rng): FoodKind {
  const plan = preyPlan(config, situation);
  if (plan.restSum === 0) return pickWeighted(plan.fixed, rng.int(0, plan.fixedSum - 1));
  if (plan.fixedSum > 0) {
    const roll = rng.int(0, BP_SCALE - 1);
    if (roll < plan.fixedSum) return pickWeighted(plan.fixed, roll);
  }
  return pickWeighted(plan.rest, rng.int(0, plan.restSum - 1));
}

const isToolKind = (value: string | null): value is ToolKind =>
  value !== null && (TOOL_KINDS as readonly string[]).includes(value);

export type HuntResult =
  | { status: 'success'; food: FoodKind; tool: ToolKind; nextAvailableAt: Date }
  | { status: 'failed'; tool: ToolKind; nextAvailableAt: Date }
  | { status: 'level_too_low'; minLevel: number }
  | { status: 'no_tool' }
  | { status: 'cooldown'; availableAt: Date; remainingMs: number; notify: boolean }
  | { status: 'banned' };

/**
 * «شکار» in a group. Without a tool or below the minimum level the player only gets
 * guidance and no cooldown is used. A valid attempt — successful or not — starts the
 * shared hunt cooldown (with this group's «شتاب شکار» buff). Success is rolled first,
 * then the prey type.
 */
export async function hunt(
  ctx: DomainContext,
  input: { userId: number; groupId: number },
): Promise<HuntResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (player.level < config.hunt.minLevel) {
      return { status: 'level_too_low', minLevel: config.hunt.minLevel };
    }
    const tool = player.equippedTool;
    if (!isToolKind(tool)) return { status: 'no_tool' };

    const availableAt = await cooldownAvailableAt(tx, input.userId, 'hunt');
    if (availableAt && isCoolingDown(availableAt, now)) {
      const notify = await claimWaitNotice(tx, {
        userId: input.userId,
        groupId: input.groupId,
        kind: 'hunt',
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

    const buffs = await groupBuffs(tx, input.groupId);
    const succeeded = ctx.rng.int(0, BP_SCALE - 1) < config.tools[tool].successBp;
    const food = succeeded
      ? pickPrey(
          config,
          {
            playerLevel: player.level,
            equippedTool: tool,
            huntingGroundLevel: buffs.huntingGroundLevel,
          },
          ctx.rng,
        )
      : null;

    if (food) {
      await tx
        .insert(inventory)
        .values({ userId: input.userId, food, quantity: 1 })
        .onConflictDoUpdate({
          target: [inventory.userId, inventory.food],
          set: { quantity: sql`${inventory.quantity} + 1` },
        });
    }
    await postTransaction(tx, {
      kind: 'hunt',
      effectiveAt: now,
      userId: input.userId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [],
      metadata: { tool, success: succeeded, food, huntingGroundLevel: buffs.huntingGroundLevel },
    });

    const effectiveSeconds = effectiveCooldownSeconds(
      config.hunt.cooldownSeconds,
      config.curses.hunt_haste.reductionPerLevelBp,
      buffs.huntHasteLevel,
    );
    const nextAvailableAt = await startCooldown(tx, {
      userId: input.userId,
      kind: 'hunt',
      now,
      groupId: input.groupId,
      baseSeconds: config.hunt.cooldownSeconds,
      effectiveSeconds,
    });
    await touchMembership(tx, input.groupId, input.userId, now, true);

    return food
      ? { status: 'success', food, tool, nextAvailableAt }
      : { status: 'failed', tool, nextAvailableAt };
  });
}
