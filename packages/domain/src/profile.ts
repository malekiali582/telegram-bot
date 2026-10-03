import { FOOD_KINDS } from '@lulu/config';
import type { FoodKind, ToolKind } from '@lulu/config';
import {
  cemeteries,
  cooldowns,
  dailyGhostState,
  foodEffects,
  inTransaction,
  inventory,
  ownedTools,
  playerState,
  users,
} from '@lulu/database';
import type { CooldownKind } from '@lulu/database';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction } from './players.ts';
import { CEMETERY_DENOMINATOR, cemeteryRateNumerator } from './settlement.ts';
import { tehranDate } from './tehran.ts';

export interface PlayerProfile {
  userId: number;
  /** Untrusted display text. */
  displayName: string;
  banned: boolean;
  level: number;
  maxLevel: number;
  nextLevelCostCenti: bigint | null;
  cashCenti: bigint;
  treasuryCenti: bigint;
  fear: number;
  tools: { owned: ToolKind[]; equipped: ToolKind | null };
  inventory: Record<FoodKind, number>;
  meals: { active: { food: FoodKind; expiresAt: Date }[]; capacity: number };
  cemetery: { level: number; hourlyIncomeCenti: bigint } | null;
  /** Only cooldowns still running. */
  waits: Partial<Record<CooldownKind, Date>>;
  ghostsToday: { found: number; limit: number };
}

/**
 * «غار من»: everything the player owns, read after settling interest and cemetery
 * income. Items are shown as counts; no made-up money value is added for tools or prey.
 */
export async function playerProfile(ctx: DomainContext, userId: number): Promise<PlayerProfile> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, userId, now);
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    const { cash, treasury } = await userWallets(tx, userId);
    const [today] = await tx
      .select({ found: dailyGhostState.foundCount })
      .from(dailyGhostState)
      .where(
        and(eq(dailyGhostState.userId, userId), eq(dailyGhostState.tehranDate, tehranDate(now))),
      );
    const owned = await tx
      .select({ tool: ownedTools.toolKind })
      .from(ownedTools)
      .where(eq(ownedTools.userId, userId));
    const stock = await tx.select().from(inventory).where(eq(inventory.userId, userId));
    const meals = await tx
      .select({ food: foodEffects.food, expiresAt: foodEffects.expiresAt })
      .from(foodEffects)
      .where(and(eq(foodEffects.userId, userId), gt(foodEffects.expiresAt, now)))
      .orderBy(asc(foodEffects.expiresAt));
    const [cemetery] = await tx.select().from(cemeteries).where(eq(cemeteries.userId, userId));
    const waits = await tx
      .select({ kind: cooldowns.kind, availableAt: cooldowns.availableAt })
      .from(cooldowns)
      .where(and(eq(cooldowns.userId, userId), gt(cooldowns.availableAt, now)));
    const [state] = await tx
      .select({ fear: playerState.fear })
      .from(playerState)
      .where(eq(playerState.userId, userId));

    const levelConfig = config.levels[player.level - 1];
    const cost = levelConfig?.upgradeCost ?? null;
    const c = config.cemetery;
    return {
      userId,
      displayName: user?.displayName ?? '؟',
      banned: player.banned,
      level: player.level,
      maxLevel: config.levels.length,
      nextLevelCostCenti: cost === null ? null : pointsToCenti(cost),
      cashCenti: cash.balance,
      treasuryCenti: treasury.balance,
      fear: state?.fear ?? 0,
      tools: {
        owned: owned.map((o) => o.tool as ToolKind),
        equipped: (player.equippedTool as ToolKind | null) ?? null,
      },
      inventory: Object.fromEntries(
        FOOD_KINDS.map((f) => [f, stock.find((s) => s.food === f)?.quantity ?? 0]),
      ) as Record<FoodKind, number>,
      meals: {
        active: meals.map((m) => ({ food: m.food as FoodKind, expiresAt: m.expiresAt })),
        capacity: levelConfig?.mealCapacity ?? 0,
      },
      cemetery: cemetery
        ? {
            level: cemetery.level,
            hourlyIncomeCenti:
              (cemeteryRateNumerator(c.baseHourlyIncome, c.levelBonusBp, cemetery.level) *
                3_600_000n) /
              CEMETERY_DENOMINATOR,
          }
        : null,
      waits: Object.fromEntries(waits.map((w) => [w.kind, w.availableAt])),
      ghostsToday: { found: today?.found ?? 0, limit: config.ghosts.dailyLimit },
    };
  });
}
