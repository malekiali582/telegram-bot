import { z } from 'zod';
import { BP_SCALE, CURSE_KINDS, FOOD_KINDS, TOOL_KINDS } from './ids.ts';
import type { CurseKind, FoodKind, ToolKind } from './ids.ts';

/**
 * Whole LuluPoints. Bounded so that the value in centi-points (×100) stays a safe
 * JavaScript integer inside JSON config documents; the domain converts to bigint.
 */
const points = z.int().min(0).max(10_000_000_000_000);
const positivePoints = points.min(1);
const bp = z.int().min(0).max(BP_SCALE);
const seconds = z
  .int()
  .min(1)
  .max(30 * 24 * 3600);
const level = z.int().min(1).max(100);

function kindRecord<K extends string, S extends z.ZodType>(kinds: readonly K[], schema: S) {
  return z.strictObject(Object.fromEntries(kinds.map((k) => [k, schema])) as Record<K, S>);
}

const playerLevelSchema = z.strictObject({
  level,
  rewardMin: z.int().min(0),
  rewardMax: z.int().min(0),
  mealCapacity: z.int().min(0),
  /** Cost to go from this level to the next; `null` on the last level. */
  upgradeCost: positivePoints.nullable(),
});

const foodSchema = z.strictObject({
  nutrition: z.int().min(1),
  minLevel: level,
  requiredTool: z.enum(TOOL_KINDS).nullable(),
});

const toolSchema = z.strictObject({
  price: points,
  successBp: bp,
});

const huntingGroundSchema = z.strictObject({
  level,
  /** Conditional prey distribution given a successful hunt; must sum to 10 000 bp. */
  weightsBp: kindRecord(FOOD_KINDS, bp),
  /** Cost (from the blood bank) to reach this level; `null` for level 1. */
  upgradeCost: positivePoints.nullable(),
});

const cityLevelSchema = z.strictObject({
  level,
  requiredActivePopulation: z.int().min(0),
  bloodBankCost: points,
  /** Consumed from the group's hunt-point pool (sum of donated count × nutrition). */
  huntPointsCost: z.int().min(0),
});

const bloodBankLevelSchema = z.strictObject({
  level,
  /** Paid from the bank's own balance to reach this level; `null` for level 1. */
  upgradeCost: positivePoints.nullable(),
  maxHuntingGroundLevel: level,
  maxCurseLevel: z.int().min(0),
});

const curseSchema = z.strictObject({
  /** Linear cooldown reduction per curse level, relative to the base cooldown. */
  reductionPerLevelBp: bp,
  /** `levelCosts[i]` buys level i+1. */
  levelCosts: z.array(positivePoints).min(1),
});

export const gameConfigSchema = z
  .strictObject({
    lolo: z.strictObject({
      cooldownSeconds: seconds,
      waitNoticeThrottleSeconds: seconds,
    }),
    levels: z.array(playerLevelSchema).min(2),
    food: z.strictObject({
      pointsPerNutritionPerSecond: z.int().min(1),
      mealDurationSeconds: seconds,
      claimWindowSeconds: seconds,
    }),
    foods: kindRecord(FOOD_KINDS, foodSchema),
    tools: kindRecord(TOOL_KINDS, toolSchema),
    hunt: z.strictObject({
      minLevel: level,
      cooldownSeconds: seconds,
    }),
    huntingGrounds: z.array(huntingGroundSchema).min(1),
    cemetery: z.strictObject({
      openCost: points,
      baseHourlyIncome: z.int().min(0),
      levelBonusBp: bp,
      maxLevel: z.int().min(0).max(20),
      /** `upgradeCosts[i]` upgrades to level i+1. */
      upgradeCosts: z.array(positivePoints),
    }),
    city: z.strictObject({
      activePopulationWindowDays: z.int().min(1).max(365),
      /** Upgrade targets, starting at level 2 (every city starts at level 1). */
      levels: z.array(cityLevelSchema).min(1),
    }),
    bloodBank: z.strictObject({
      /** Starts at level 1 so that level 1's caps are explicit. */
      levels: z.array(bloodBankLevelSchema).min(1),
    }),
    curses: kindRecord(CURSE_KINDS, curseSchema),
    ghosts: z.strictObject({
      baseChanceBp: bp,
      cityLevelBonusBp: bp,
      failureMultiplierBp: bp,
      minChanceBp: bp,
      dailyLimit: z.int().min(1).max(100),
      cooldownSeconds: seconds,
      fearMin: z.int().min(0),
      fearMax: z.int().min(0),
      replyDeadlineHours: z
        .int()
        .min(1)
        .max(24 * 30),
      batchSize: z.int().min(1).max(50),
    }),
    treasury: z.strictObject({
      dailyInterestBp: bp,
    }),
    transfer: z.strictObject({
      feeBp: bp,
    }),
    confirmations: z.strictObject({
      ttlSeconds: z.int().min(10).max(3600),
    }),
    admin: z.strictObject({
      loginMaxAttempts: z.int().min(1).max(100),
      loginWindowMinutes: z
        .int()
        .min(1)
        .max(24 * 60),
      sessionTtlHours: z
        .int()
        .min(1)
        .max(24 * 30),
      sessionIdleMinutes: z
        .int()
        .min(5)
        .max(24 * 60),
    }),
  })
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    // Player levels: contiguous from 1; only the last one has no upgrade cost.
    const maxPlayerLevel = c.levels.length;
    c.levels.forEach((l, i) => {
      if (l.level !== i + 1) issue(['levels', i, 'level'], `expected level ${i + 1}`);
      if (l.rewardMin > l.rewardMax) issue(['levels', i, 'rewardMin'], 'rewardMin > rewardMax');
      const isLast = i === maxPlayerLevel - 1;
      if (isLast !== (l.upgradeCost === null)) {
        issue(['levels', i, 'upgradeCost'], 'only the last level has a null upgradeCost');
      }
    });

    if (c.food.claimWindowSeconds > c.food.mealDurationSeconds) {
      issue(['food', 'claimWindowSeconds'], 'claim window cannot exceed meal duration');
    }

    for (const kind of FOOD_KINDS) {
      if (c.foods[kind].minLevel > maxPlayerLevel) {
        issue(['foods', kind, 'minLevel'], `minLevel exceeds max player level ${maxPlayerLevel}`);
      }
    }
    if (c.hunt.minLevel > maxPlayerLevel) issue(['hunt', 'minLevel'], 'above max player level');

    // Hunting grounds: contiguous, each row is a full distribution.
    c.huntingGrounds.forEach((g, i) => {
      if (g.level !== i + 1) issue(['huntingGrounds', i, 'level'], `expected level ${i + 1}`);
      if ((i === 0) !== (g.upgradeCost === null)) {
        issue(['huntingGrounds', i, 'upgradeCost'], 'only level 1 has a null upgradeCost');
      }
      const sum = FOOD_KINDS.reduce((acc, k) => acc + g.weightsBp[k], 0);
      if (sum !== BP_SCALE) {
        issue(['huntingGrounds', i, 'weightsBp'], `weights sum to ${sum} bp, expected ${BP_SCALE}`);
      }
    });

    if (c.cemetery.upgradeCosts.length !== c.cemetery.maxLevel) {
      issue(['cemetery', 'upgradeCosts'], `expected ${c.cemetery.maxLevel} upgrade costs`);
    }

    c.city.levels.forEach((l, i) => {
      if (l.level !== i + 2) issue(['city', 'levels', i, 'level'], `expected level ${i + 2}`);
    });
    const maxCityLevel = c.city.levels.length + 1;

    const maxCurseLevel = Math.min(...CURSE_KINDS.map((k) => c.curses[k].levelCosts.length));
    c.bloodBank.levels.forEach((l, i) => {
      const path = ['bloodBank', 'levels', i];
      if (l.level !== i + 1) issue([...path, 'level'], `expected level ${i + 1}`);
      if ((i === 0) !== (l.upgradeCost === null)) {
        issue([...path, 'upgradeCost'], 'only level 1 has a null upgradeCost');
      }
      if (l.maxHuntingGroundLevel > c.huntingGrounds.length) {
        issue([...path, 'maxHuntingGroundLevel'], 'exceeds defined hunting ground levels');
      }
      if (l.maxCurseLevel > maxCurseLevel) {
        issue([...path, 'maxCurseLevel'], 'exceeds defined curse levels');
      }
      const prev = c.bloodBank.levels[i - 1];
      if (
        prev &&
        (l.maxHuntingGroundLevel < prev.maxHuntingGroundLevel ||
          l.maxCurseLevel < prev.maxCurseLevel)
      ) {
        issue(path, 'caps must not decrease with bank level');
      }
    });
    if (c.bloodBank.levels.length > maxCityLevel) {
      issue(['bloodBank', 'levels'], 'bank level can never exceed the city level');
    }

    for (const kind of CURSE_KINDS) {
      const curse = c.curses[kind];
      if (curse.reductionPerLevelBp * curse.levelCosts.length >= BP_SCALE) {
        issue(['curses', kind], 'max curse level would reduce the cooldown to zero');
      }
    }

    const g = c.ghosts;
    if (g.minChanceBp > g.baseChanceBp) issue(['ghosts', 'minChanceBp'], 'above base chance');
    if (g.baseChanceBp + g.cityLevelBonusBp * (maxCityLevel - 1) > BP_SCALE) {
      issue(['ghosts', 'cityLevelBonusBp'], 'chance exceeds 100% at max city level');
    }
    if (g.fearMin > g.fearMax) issue(['ghosts', 'fearMin'], 'fearMin > fearMax');
  });

export type GameConfig = z.infer<typeof gameConfigSchema>;
export type PlayerLevelConfig = GameConfig['levels'][number];
export type FoodConfig = GameConfig['foods'][FoodKind];
export type ToolConfig = GameConfig['tools'][ToolKind];
export type CurseConfig = GameConfig['curses'][CurseKind];
export type HuntingGroundConfig = GameConfig['huntingGrounds'][number];
