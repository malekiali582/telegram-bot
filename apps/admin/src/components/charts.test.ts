import { describe, expect, it } from 'vitest';
import { niceStep } from './charts.tsx';

describe('chart axis steps', () => {
  it('picks the smallest round step that covers the maximum', () => {
    // 2 001 161 in five steps: 500 000 (top 2.5 M), not 1 000 000 (top 3 M).
    expect(niceStep(2_001_161, 5)).toBe(500_000);
    expect(niceStep(2_000_000, 4)).toBe(500_000);
    expect(niceStep(2_000_001, 4)).toBe(1_000_000);
    expect(niceStep(90, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(2);
    expect(niceStep(0, 5)).toBe(1);
  });
});
