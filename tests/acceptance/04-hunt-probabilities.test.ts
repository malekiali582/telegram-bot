/**
 * Acceptance 4 (spec §19.4): every hunting row sums to 100 %, the distribution after
 * removing locked prey, human impossible without level 6 + magic wand, and exactly
 * 0.5 % (grounds 1–4) or 3 % (ground 5) when allowed.
 */
import { BP_SCALE, DEFAULT_GAME_CONFIG, FOOD_KINDS, TOOL_KINDS } from '@lulu/config';
import type { FoodKind, ToolKind } from '@lulu/config';
import type { HuntSituation } from '@lulu/domain';
import { pickPrey, preyDistribution } from '@lulu/domain';
import { TestRng } from '@lulu/domain/testing';
import { describe, expect, it } from 'vitest';

const config = DEFAULT_GAME_CONFIG;
const total = (dist: ReturnType<typeof preyDistribution>) =>
  dist.reduce(
    (acc, p) => ({
      n: acc.n * p.denominator + p.numerator * acc.d,
      d: acc.d * p.denominator,
    }),
    { n: 0n, d: 1n },
  );
const probability = (dist: ReturnType<typeof preyDistribution>, food: FoodKind) => {
  const p = dist.find((x) => x.food === food);
  return p ? Number(p.numerator) / Number(p.denominator) : 0;
};
const exact = (dist: ReturnType<typeof preyDistribution>, food: FoodKind) =>
  dist.find((x) => x.food === food);

const situations: HuntSituation[] = [];
for (let playerLevel = 2; playerLevel <= 6; playerLevel++) {
  for (const equippedTool of [...TOOL_KINDS, null] as (ToolKind | null)[]) {
    for (let huntingGroundLevel = 1; huntingGroundLevel <= 5; huntingGroundLevel++) {
      situations.push({ playerLevel, equippedTool, huntingGroundLevel });
    }
  }
}

describe('acceptance 4 — hunting probabilities', () => {
  it('every hunting ground row sums to exactly 100 %', () => {
    for (const ground of config.huntingGrounds) {
      expect(FOOD_KINDS.reduce((acc, f) => acc + ground.weightsBp[f], 0)).toBe(BP_SCALE);
    }
  });

  it('every distribution after filtering sums to exactly 1 (all 150 situations)', () => {
    for (const situation of situations) {
      const { n, d } = total(preyDistribution(config, situation));
      expect(n, JSON.stringify(situation)).toBe(d);
    }
  });

  it('removes prey above the player level and renormalizes the rest', () => {
    const level2 = preyDistribution(config, {
      playerLevel: 2,
      equippedTool: 'knife',
      huntingGroundLevel: 1,
    });
    expect(level2.map((p) => p.food)).toEqual(['bone']);
    expect(probability(level2, 'bone')).toBe(1);

    const level3 = preyDistribution(config, {
      playerLevel: 3,
      equippedTool: 'knife',
      huntingGroundLevel: 1,
    });
    // bone 40 : mouse 24 → 40/64 and 24/64
    expect(probability(level3, 'bone')).toBeCloseTo(40 / 64, 12);
    expect(probability(level3, 'mouse')).toBeCloseTo(24 / 64, 12);

    const level5 = preyDistribution(config, {
      playerLevel: 5,
      equippedTool: 'bow',
      huntingGroundLevel: 1,
    });
    expect(level5.map((p) => p.food)).toEqual([
      'bone',
      'mouse',
      'chicken',
      'pig',
      'sheep',
      'cow',
      'deer',
    ]);
    // human's 0.5 % is dropped and the rest scaled to 100 %
    expect(probability(level5, 'bone')).toBeCloseTo(40 / 99.5, 12);
  });

  it('human has probability 0 without both level 6 and the magic wand equipped', () => {
    for (const situation of situations) {
      const allowed = situation.playerLevel === 6 && situation.equippedTool === 'magic_wand';
      if (!allowed) {
        expect(exact(preyDistribution(config, situation), 'human'), JSON.stringify(situation)).toBe(
          undefined,
        );
      }
    }
  });

  it('human is exactly 0.5 % on grounds 1–4 and exactly 3 % on ground 5 when allowed', () => {
    for (let groundLevel = 1; groundLevel <= 5; groundLevel++) {
      const dist = preyDistribution(config, {
        playerLevel: 6,
        equippedTool: 'magic_wand',
        huntingGroundLevel: groundLevel,
      });
      const human = exact(dist, 'human');
      if (!human) throw new Error('human must be possible here');
      const expectedBp = groundLevel === 5 ? 300n : 50n;
      // numerator / denominator === expectedBp / 10 000, compared exactly
      expect(human.numerator * 10_000n).toBe(expectedBp * human.denominator);
    }
  });

  it('with human allowed, the others keep their table weights exactly', () => {
    const dist = preyDistribution(config, {
      playerLevel: 6,
      equippedTool: 'magic_wand',
      huntingGroundLevel: 5,
    });
    for (const food of FOOD_KINDS) {
      expect(probability(dist, food)).toBeCloseTo(
        config.huntingGrounds[4]!.weightsBp[food] / 10_000,
        12,
      );
    }
  });

  it('sampling realizes the distribution exactly (exhaustive over every roll)', () => {
    const situation: HuntSituation = {
      playerLevel: 6,
      equippedTool: 'magic_wand',
      huntingGroundLevel: 1,
    };
    // first roll: 0..9999 decides human (0..49) vs the rest
    const firstRoll = new Map<FoodKind | 'rest', number>();
    for (let roll = 0; roll < BP_SCALE; roll++) {
      const rng = new TestRng().push(roll);
      rng.fallback = 'min';
      const food = pickPrey(config, situation, rng);
      const key = rng.calls.length === 1 ? food : 'rest';
      firstRoll.set(key, (firstRoll.get(key) ?? 0) + 1);
    }
    expect(firstRoll.get('human')).toBe(50);
    expect(firstRoll.get('rest')).toBe(9_950);

    // second roll among the rest: each food occupies exactly its table weight
    const weights = config.huntingGrounds[0]!.weightsBp;
    const restSum = FOOD_KINDS.filter((f) => f !== 'human').reduce((a, f) => a + weights[f], 0);
    const counts = new Map<FoodKind, number>();
    for (let roll = 0; roll < restSum; roll++) {
      const food = pickPrey(config, situation, new TestRng().push(9_999, roll));
      counts.set(food, (counts.get(food) ?? 0) + 1);
    }
    for (const food of FOOD_KINDS.filter((f) => f !== 'human')) {
      expect(counts.get(food), food).toBe(weights[food]);
    }
  });

  it('never samples human when not allowed, whatever the rolls', () => {
    const situation: HuntSituation = { playerLevel: 6, equippedTool: 'bow', huntingGroundLevel: 5 };
    for (let roll = 0; roll < 9_700; roll++) {
      expect(pickPrey(config, situation, new TestRng().push(roll))).not.toBe('human');
    }
  });
});
