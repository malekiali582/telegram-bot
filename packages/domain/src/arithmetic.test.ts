import { describe, expect, it } from 'vitest';
import { effectiveCooldownSeconds, isCoolingDown } from './cooldowns.ts';
import { ceilDiv, pointsToCenti } from './money.ts';
import { depositsDue } from './settlement.ts';

const T0 = Date.parse('2026-10-02T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const meal = { startedAt: at(0), depositIntervalSeconds: 300, depositsTotal: 6 };

describe('food deposits (spec §9): one at the end of every 5 minutes, six per meal', () => {
  it('pays nothing before the first 5 minutes are over', () => {
    expect(depositsDue(meal, at(-10))).toBe(0);
    expect(depositsDue(meal, at(0))).toBe(0);
    expect(depositsDue(meal, new Date(T0 + 299_999))).toBe(0);
  });

  it('makes each deposit due exactly at its instant', () => {
    expect(depositsDue(meal, at(300))).toBe(1);
    expect(depositsDue(meal, at(599))).toBe(1);
    expect(depositsDue(meal, at(600))).toBe(2);
    expect(depositsDue(meal, at(1799))).toBe(5);
    expect(depositsDue(meal, at(1800))).toBe(6);
  });

  it('never pays more than six deposits, however late it is settled', () => {
    expect(depositsDue(meal, at(1800 + 86_400))).toBe(6);
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
