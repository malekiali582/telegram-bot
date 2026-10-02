import { describe, expect, it } from 'vitest';
import { effectiveCooldownSeconds, isCoolingDown } from './cooldowns.ts';
import type { ActiveMeal } from './food.ts';
import { foodBonusPoints, foodWindowStart } from './food.ts';
import { ceilDiv, pointsToCenti } from './money.ts';

const T0 = Date.parse('2026-10-02T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const meal = (pps: number, startS: number, endS: number): ActiveMeal => ({
  pointsPerSecond: pps,
  startedAt: at(startS),
  expiresAt: at(endS),
});
const BONE = 5; // 5 × nutrition 1
const MOUSE = 10; // 5 × nutrition 2

describe('food window (spec §9 formula)', () => {
  it('starts at the later of the last lolo and now − 300 s', () => {
    expect(foodWindowStart(at(100), at(0), at(200), 300)).toEqual(at(100));
    expect(foodWindowStart(at(100), at(0), at(1000), 300)).toEqual(at(700));
  });

  it('uses the account start when there was no successful lolo yet', () => {
    expect(foodWindowStart(null, at(50), at(120), 300)).toEqual(at(50));
  });
});

describe('food bonus', () => {
  it('spec example: a bone active for the whole 300 s gives 1500', () => {
    expect(foodBonusPoints([meal(BONE, -100, 1700)], at(0), at(300))).toBe(1500n);
  });

  it('spec example: a mouse active for only 120 s gives 1200', () => {
    expect(foodBonusPoints([meal(MOUSE, 180, 1980)], at(0), at(300))).toBe(1200n);
  });

  it('spec example: nothing for a meal that ended before a 40-minute gap', () => {
    const start = foodWindowStart(at(0), at(0), at(2400), 300);
    expect(foodBonusPoints([meal(BONE, 0, 1800)], start, at(2400))).toBe(0n);
  });

  it('counts a meal that expired a minute ago for the 4 minutes it covered', () => {
    const start = foodWindowStart(at(1500), at(0), at(1860), 300);
    expect(foodBonusPoints([meal(BONE, 0, 1800)], start, at(1860))).toBe(1200n);
  });

  it('gives nothing for time before the meal was eaten', () => {
    expect(foodBonusPoints([meal(BONE, 200, 2000)], at(0), at(300))).toBe(500n);
  });

  it('treats boundaries as half-open: touching intervals overlap for 0 s', () => {
    expect(foodBonusPoints([meal(BONE, 300, 2100)], at(0), at(300))).toBe(0n);
    expect(foodBonusPoints([meal(BONE, -1800, 0)], at(0), at(300))).toBe(0n);
  });

  it('rounds down only the final sum, not each meal', () => {
    // each bone overlaps 100.1 s = 500.5 points; two of them = 1001, not 1000
    const meals = [meal(BONE, 199.9, 2000), meal(BONE, 199.9, 2000)];
    expect(foodBonusPoints(meals, at(0), at(300))).toBe(1001n);
    expect(foodBonusPoints(meals.slice(0, 1), at(0), at(300))).toBe(500n);
  });

  it('adds independent meals', () => {
    expect(foodBonusPoints([meal(BONE, 0, 1800), meal(MOUSE, 0, 1800)], at(0), at(300))).toBe(
      4500n,
    );
  });
});

describe('cooldowns', () => {
  it('reduces linearly per curse level and never below what is configured', () => {
    expect(effectiveCooldownSeconds(300, 500, 0)).toBe(300);
    expect(effectiveCooldownSeconds(300, 500, 4)).toBe(240); // «۴ دقیقه»
    expect(effectiveCooldownSeconds(3600, 500, 4)).toBe(2880); // «۴۸ دقیقه»
    expect(effectiveCooldownSeconds(301, 500, 1)).toBe(286); // 285.95 rounded up
    expect(() => effectiveCooldownSeconds(300, 5000, 2)).toThrow(RangeError);
  });

  it('ends exactly at availableAt (half-open)', () => {
    expect(isCoolingDown(undefined, at(0))).toBe(false);
    expect(isCoolingDown(at(300), new Date(T0 + 299_999))).toBe(true);
    expect(isCoolingDown(at(300), at(300))).toBe(false);
  });
});

describe('money helpers', () => {
  it('converts whole points to centi and rejects fractions', () => {
    expect(pointsToCenti(18_000_000)).toBe(1_800_000_000n);
    expect(() => pointsToCenti(1.5)).toThrow(RangeError);
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(8n, 2n)).toBe(4n);
  });
});
