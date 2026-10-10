import type { GameConfig } from './schema.ts';

/**
 * Version-1 defaults, taken from the owner's specification (PROMPT.md).
 * Which values are owner rules (`fixed`) and which are starting suggestions
 * (`suggested`) is declared in `labels.ts` and documented in docs/assumptions.md.
 * Suggested values must not be changed silently; propose changes in the
 * simulation report instead.
 */
export const DEFAULT_GAME_CONFIG: GameConfig = {
  lolo: {
    cooldownSeconds: 300,
    waitNoticeThrottleSeconds: 60,
  },
  levels: [
    { level: 1, rewardMin: 1, rewardMax: 10, mealCapacity: 0, upgradeCost: 300 },
    { level: 2, rewardMin: 10, rewardMax: 50, mealCapacity: 1, upgradeCost: 6_000 },
    { level: 3, rewardMin: 50, rewardMax: 150, mealCapacity: 3, upgradeCost: 90_000 },
    { level: 4, rewardMin: 150, rewardMax: 300, mealCapacity: 15, upgradeCost: 1_500_000 },
    { level: 5, rewardMin: 300, rewardMax: 650, mealCapacity: 30, upgradeCost: 18_000_000 },
    { level: 6, rewardMin: 650, rewardMax: 1_150, mealCapacity: 50, upgradeCost: null },
  ],
  food: {
    mealDurationSeconds: 1_800,
    depositIntervalSeconds: 300,
  },
  foods: {
    bone: { nutrition: 1, pointsPerDeposit: 3, minLevel: 2, requiredTool: null },
    mouse: { nutrition: 2, pointsPerDeposit: 20, minLevel: 3, requiredTool: null },
    chicken: { nutrition: 4, pointsPerDeposit: 70, minLevel: 4, requiredTool: null },
    pig: { nutrition: 9, pointsPerDeposit: 150, minLevel: 4, requiredTool: null },
    sheep: { nutrition: 14, pointsPerDeposit: 270, minLevel: 5, requiredTool: null },
    cow: { nutrition: 20, pointsPerDeposit: 360, minLevel: 5, requiredTool: null },
    deer: { nutrition: 30, pointsPerDeposit: 500, minLevel: 5, requiredTool: null },
    human: { nutrition: 50, pointsPerDeposit: 1_000, minLevel: 6, requiredTool: 'magic_wand' },
  },
  tools: {
    knife: { price: 500, successBp: 6_000 },
    axe: { price: 7_500, successBp: 7_000 },
    sword: { price: 55_000, successBp: 8_000 },
    bow: { price: 450_000, successBp: 9_000 },
    magic_wand: { price: 4_000_000, successBp: 10_000 },
  },
  hunt: {
    minLevel: 2,
    cooldownSeconds: 3_600,
  },
  huntingGrounds: [
    {
      level: 1,
      weightsBp: {
        bone: 4_000,
        mouse: 2_400,
        chicken: 1_500,
        pig: 900,
        sheep: 500,
        cow: 350,
        deer: 300,
        human: 50,
      },
      upgradeCost: null,
    },
    {
      level: 2,
      weightsBp: {
        bone: 3_800,
        mouse: 2_400,
        chicken: 1_500,
        pig: 900,
        sheep: 575,
        cow: 415,
        deer: 360,
        human: 50,
      },
      upgradeCost: 10_000,
    },
    {
      level: 3,
      weightsBp: {
        bone: 3_600,
        mouse: 2_400,
        chicken: 1_500,
        pig: 900,
        sheep: 650,
        cow: 480,
        deer: 420,
        human: 50,
      },
      upgradeCost: 100_000,
    },
    {
      level: 4,
      weightsBp: {
        bone: 3_400,
        mouse: 2_400,
        chicken: 1_500,
        pig: 900,
        sheep: 725,
        cow: 545,
        deer: 480,
        human: 50,
      },
      upgradeCost: 750_000,
    },
    {
      level: 5,
      weightsBp: {
        bone: 2_950,
        mouse: 2_400,
        chicken: 1_500,
        pig: 900,
        sheep: 800,
        cow: 610,
        deer: 540,
        human: 300,
      },
      upgradeCost: 4_000_000,
    },
  ],
  cemetery: {
    openCost: 1_000,
    baseHourlyIncome: 50,
    levelBonusBp: 500,
    maxLevel: 3,
    upgradeCosts: [500, 1_000, 2_000],
  },
  city: {
    activePopulationWindowDays: 7,
    levels: [
      { level: 2, requiredActivePopulation: 3, bloodBankCost: 10_000, huntPointsCost: 10 },
      { level: 3, requiredActivePopulation: 5, bloodBankCost: 100_000, huntPointsCost: 50 },
      { level: 4, requiredActivePopulation: 10, bloodBankCost: 750_000, huntPointsCost: 200 },
      { level: 5, requiredActivePopulation: 20, bloodBankCost: 5_000_000, huntPointsCost: 800 },
    ],
  },
  bloodBank: {
    levels: [
      { level: 1, upgradeCost: null, maxHuntingGroundLevel: 1, maxCurseLevel: 0 },
      { level: 2, upgradeCost: 5_000, maxHuntingGroundLevel: 2, maxCurseLevel: 1 },
      { level: 3, upgradeCost: 50_000, maxHuntingGroundLevel: 3, maxCurseLevel: 2 },
      { level: 4, upgradeCost: 300_000, maxHuntingGroundLevel: 4, maxCurseLevel: 3 },
      { level: 5, upgradeCost: 2_000_000, maxHuntingGroundLevel: 5, maxCurseLevel: 4 },
    ],
  },
  curses: {
    hunt_haste: { reductionPerLevelBp: 500, levelCosts: [10_000, 100_000, 750_000, 4_000_000] },
    lolo_echo: { reductionPerLevelBp: 500, levelCosts: [10_000, 100_000, 750_000, 4_000_000] },
  },
  ghosts: {
    baseChanceBp: 3_000,
    cityLevelBonusBp: 200,
    failureStepBp: 100,
    minChanceBp: 1_000,
    dailyLimit: 3,
    dailyAttempts: 10,
    cooldownSeconds: 600,
    rewardPerMember: 50,
    memberActivityWindowDays: 7,
    replyDeadlineHours: 24,
    batchSize: 5,
  },
  treasury: {
    dailyInterestBp: 300,
  },
  streak: {
    baseReward: 10,
    dailyIncrement: 5,
    maxDays: 30,
    groupRewardPerMember: 100,
    groupMemberCap: 20,
    minAccountAgeDays: 3,
  },
  transfer: {
    feeBp: 0,
  },
  confirmations: {
    ttlSeconds: 120,
  },
  admin: {
    loginMaxAttempts: 5,
    loginWindowMinutes: 15,
    sessionTtlHours: 12,
    sessionIdleMinutes: 120,
  },
};
