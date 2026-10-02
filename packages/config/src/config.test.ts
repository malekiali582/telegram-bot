import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG } from './defaults.ts';
import { BP_SCALE, FOOD_KINDS } from './ids.ts';
import {
  LABEL_RULES,
  configLeaves,
  diffConfig,
  labelOf,
  normalizeConfigPath,
  patternMatches,
  requiresOwnerApproval,
} from './labels.ts';
import type { GameConfig } from './schema.ts';
import { gameConfigSchema } from './schema.ts';

const clone = (): GameConfig => structuredClone(DEFAULT_GAME_CONFIG);

function issuesOf(config: unknown): string[] {
  const result = gameConfigSchema.safeParse(config);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('default game config', () => {
  it('passes its own schema', () => {
    expect(issuesOf(DEFAULT_GAME_CONFIG)).toEqual([]);
  });

  it("matches the owner's explicit numbers", () => {
    const c = DEFAULT_GAME_CONFIG;
    expect(c.levels.map((l) => [l.rewardMin, l.rewardMax, l.mealCapacity])).toEqual([
      [1, 10, 0],
      [10, 50, 1],
      [50, 150, 3],
      [150, 300, 15],
      [300, 650, 30],
      [650, 1150, 50],
    ]);
    expect(c.lolo.cooldownSeconds).toBe(300);
    expect(c.hunt.cooldownSeconds).toBe(3600);
    expect(c.food).toEqual({
      pointsPerNutritionPerSecond: 5,
      mealDurationSeconds: 1800,
      claimWindowSeconds: 300,
    });
    expect(c.cemetery.openCost).toBe(1000);
    expect(c.treasury.dailyInterestBp).toBe(300);
    expect(c.ghosts.dailyLimit).toBe(3);
    expect(c.foods.human).toEqual({ nutrition: 50, minLevel: 6, requiredTool: 'magic_wand' });
  });

  it('has hunting-ground rows that sum to exactly 100% with human at 0.5% / 3%', () => {
    for (const ground of DEFAULT_GAME_CONFIG.huntingGrounds) {
      const sum = FOOD_KINDS.reduce((acc, k) => acc + ground.weightsBp[k], 0);
      expect(sum, `ground ${ground.level}`).toBe(BP_SCALE);
    }
    const human = DEFAULT_GAME_CONFIG.huntingGrounds.map((g) => g.weightsBp.human);
    expect(human).toEqual([50, 50, 50, 50, 300]);
  });

  it('moves 2 points from bone to sheep/cow/deer per upgrade, plus 2.5 to human at the top', () => {
    const g = DEFAULT_GAME_CONFIG.huntingGrounds;
    for (let i = 1; i < g.length; i++) {
      const prev = g[i - 1]!.weightsBp;
      const cur = g[i]!.weightsBp;
      const extraToHuman = cur.human - prev.human;
      expect(prev.bone - cur.bone).toBe(200 + extraToHuman);
      expect(cur.sheep + cur.cow + cur.deer - (prev.sheep + prev.cow + prev.deer)).toBe(200);
    }
    expect(g[4]!.weightsBp.human - g[3]!.weightsBp.human).toBe(250);
  });
});

describe('game config validation', () => {
  it('rejects a hunting row that does not sum to 100%', () => {
    const c = clone();
    c.huntingGrounds[0]!.weightsBp.bone += 1;
    expect(issuesOf(c)).toEqual([expect.stringContaining('huntingGrounds.0.weightsBp')]);
  });

  it('rejects non-contiguous levels and misplaced null upgrade costs', () => {
    const c = clone();
    c.levels[2]!.level = 7;
    c.levels[5]!.upgradeCost = 100;
    const issues = issuesOf(c);
    expect(issues).toContainEqual(expect.stringContaining('levels.2.level'));
    expect(issues).toContainEqual(expect.stringContaining('levels.5.upgradeCost'));
  });

  it('rejects inverted ranges, unknown keys, fractional and negative values', () => {
    const inverted = clone();
    inverted.levels[0]!.rewardMin = 11;
    expect(issuesOf(inverted)).toContainEqual(expect.stringContaining('rewardMin > rewardMax'));

    expect(issuesOf({ ...clone(), extra: 1 })).not.toEqual([]);

    const fractional = clone();
    fractional.tools.knife.price = 500.5;
    expect(issuesOf(fractional)).not.toEqual([]);

    const negative = clone();
    negative.cemetery.openCost = -1;
    expect(issuesOf(negative)).not.toEqual([]);
  });

  it('rejects cross-field inconsistencies', () => {
    const cemetery = clone();
    cemetery.cemetery.upgradeCosts.pop();
    expect(issuesOf(cemetery)).toContainEqual(expect.stringContaining('cemetery.upgradeCosts'));

    const ghost = clone();
    ghost.ghosts.minChanceBp = 4000;
    expect(issuesOf(ghost)).toContainEqual(expect.stringContaining('ghosts.minChanceBp'));

    const bank = clone();
    bank.bloodBank.levels[1]!.maxCurseLevel = 9;
    expect(issuesOf(bank)).toContainEqual(expect.stringContaining('maxCurseLevel'));

    const curse = clone();
    curse.curses.lolo_echo.reductionPerLevelBp = 2500;
    expect(issuesOf(curse)).toContainEqual(expect.stringContaining('curses.lolo_echo'));
  });
});

describe('fixed / suggested labels', () => {
  const leaves = configLeaves(DEFAULT_GAME_CONFIG);

  it('labels every config value', () => {
    const unlabeled = leaves.filter((l) => {
      try {
        labelOf(l.path);
        return false;
      } catch {
        return true;
      }
    });
    expect(unlabeled.map((l) => l.path)).toEqual([]);
  });

  it('has no dead label rules', () => {
    const dead = LABEL_RULES.filter(
      (rule) => !leaves.some((l) => patternMatches(rule.pattern, normalizeConfigPath(l.path))),
    );
    expect(dead.map((r) => r.pattern)).toEqual([]);
  });

  it('keeps the human exception: its nutrition is suggested, other foods are fixed', () => {
    expect(labelOf('foods.human.nutrition')).toBe('suggested');
    expect(labelOf('foods.bone.nutrition')).toBe('fixed');
    expect(labelOf('foods.human.minLevel')).toBe('fixed');
  });

  it('labels the core owner rules as fixed and prices as suggested', () => {
    for (const path of [
      'lolo.cooldownSeconds',
      'levels[3].rewardMax',
      'food.pointsPerNutritionPerSecond',
      'cemetery.openCost',
      'treasury.dailyInterestBp',
      'ghosts.dailyLimit',
    ]) {
      expect(labelOf(path), path).toBe('fixed');
    }
    for (const path of [
      'levels[0].upgradeCost',
      'tools.magic_wand.price',
      'huntingGrounds[4].weightsBp.human',
      'cemetery.upgradeCosts[2]',
      'ghosts.fearMax',
    ]) {
      expect(labelOf(path), path).toBe('suggested');
    }
  });
});

describe('diffConfig / owner approval', () => {
  it('reports no changes for identical documents', () => {
    expect(diffConfig(DEFAULT_GAME_CONFIG, clone())).toEqual([]);
  });

  it('lets admins change suggested values without owner approval', () => {
    const next = clone();
    next.tools.knife.price = 600;
    next.huntingGrounds[0]!.weightsBp.bone = 3_900;
    next.huntingGrounds[0]!.weightsBp.mouse = 2_500;
    const changes = diffConfig(DEFAULT_GAME_CONFIG, next);
    expect(changes.map((c) => c.path).sort()).toEqual([
      'huntingGrounds[0].weightsBp.bone',
      'huntingGrounds[0].weightsBp.mouse',
      'tools.knife.price',
    ]);
    expect(requiresOwnerApproval(changes)).toBe(false);
  });

  it('requires owner approval as soon as one fixed rule changes', () => {
    const next = clone();
    next.tools.knife.price = 600;
    next.treasury.dailyInterestBp = 200;
    const changes = diffConfig(DEFAULT_GAME_CONFIG, next);
    expect(changes).toContainEqual({
      path: 'treasury.dailyInterestBp',
      label: 'fixed',
      before: 300,
      after: 200,
    });
    expect(requiresOwnerApproval(changes)).toBe(true);
  });

  it('treats adding a level as a structural (fixed) change', () => {
    const next = clone();
    next.city.levels.push({
      level: 6,
      requiredActivePopulation: 40,
      bloodBankCost: 1,
      huntPointsCost: 1,
    });
    const changes = diffConfig(DEFAULT_GAME_CONFIG, next);
    expect(changes).toContainEqual(
      expect.objectContaining({ path: 'city.levels[4].level', before: undefined, after: 6 }),
    );
    expect(requiresOwnerApproval(changes)).toBe(true);
  });
});
