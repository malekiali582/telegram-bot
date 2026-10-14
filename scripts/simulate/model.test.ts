import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { describe, expect, it } from 'vitest';
import { SOURCES, groupMix, simulate } from './model.ts';

const run = (seed: number, size = 6, days = 3) =>
  simulate(DEFAULT_GAME_CONFIG, { seed, days, mix: groupMix(size) });

describe('economy simulation', () => {
  it('is reproducible: the same seed gives the same result', () => {
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('builds a group of 30 % low, 50 % normal and 20 % high activity players', () => {
    expect(groupMix(20).filter((p) => p === 'low')).toHaveLength(6);
    expect(groupMix(20).filter((p) => p === 'normal')).toHaveLength(10);
    expect(groupMix(20).filter((p) => p === 'high')).toHaveLength(4);
    expect(new Set(groupMix(3))).toEqual(new Set(['low', 'normal', 'high']));
  });

  it('keeps the books: balance = everything earned − everything spent', () => {
    for (const p of run(7).players) {
      for (const d of p.days) {
        const earned = SOURCES.reduce((acc, k) => acc + d.earned[k], 0);
        const spent = d.spent.level + d.spent.tool + d.spent.cemetery;
        expect(d.cash + d.treasury).toBeCloseTo(earned - spent, 6);
      }
    }
  });

  it('pays every member 50 per ghost heard, finder included', () => {
    const r = run(11);
    const heard = r.ghostsHeardPerDay.reduce((a, b) => a + b, 0);
    expect(heard).toBeGreaterThan(0);
    for (const p of r.players) expect(p.days.at(-1)!.earned.ghost).toBe(heard * 50);
  });

  it('pays the streak reward of a day at the next midnight, growing day by day', () => {
    const r = run(3, 3, 5);
    for (const p of r.players) {
      const streak = p.days.map((d) => d.earned.streak);
      expect(streak[0]).toBe(0); // day 1 is paid at the start of day 2
      // everyone plays daily: 10, 15, 20 personal; group part from day 4 (accounts 3 days old)
      expect(streak.slice(1, 4)).toEqual([10, 25, 45]);
      expect(streak[4]! - streak[3]!).toBe(25 + 300);
    }
  });

  it('never finds more than 3 ghosts per player per day', () => {
    const r = run(5, 4, 2);
    for (const day of r.ghostsHeardPerDay) expect(day).toBeLessThanOrEqual(3 * r.groupSize);
  });

  it('accepts what-if interest rules and extra purchases, and is unchanged without them', () => {
    const base = run(5, 6, 4);
    expect(
      simulate(DEFAULT_GAME_CONFIG, {
        seed: 5,
        days: 4,
        mix: groupMix(6),
        interestCenti: (t) =>
          Math.floor((t * DEFAULT_GAME_CONFIG.treasury.dailyInterestBp) / 10_000),
      }),
    ).toEqual(base);
    const noInterest = simulate(DEFAULT_GAME_CONFIG, {
      seed: 5,
      days: 4,
      mix: groupMix(6),
      interestCenti: () => 0,
    });
    for (const p of noInterest.players) expect(p.days.at(-1)!.earned.interest).toBe(0);
    const withSink = simulate(DEFAULT_GAME_CONFIG, {
      seed: 5,
      days: 4,
      mix: groupMix(6),
      extraGoals: [{ id: 'trinket', cost: 50 }],
    });
    const spentTools = (r: typeof base) =>
      r.players.reduce((a, p) => a + p.days.at(-1)!.spent.tool, 0);
    expect(spentTools(withSink)).toBeGreaterThan(spentTools(base));
  });
});
