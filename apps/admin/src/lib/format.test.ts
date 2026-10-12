import { describe, expect, it } from 'vitest';
import { faDigits, formatDate, formatDateTime, formatDuration, formatNumber } from './format.ts';

describe('Persian formatting', () => {
  it('shows Solar Hijri dates on the Tehran calendar day', () => {
    // 20:30 UTC on 20 March 2026 is already 00:00 on 1 Farvardin 1405 in Tehran.
    expect(formatDate('2026-03-20T20:30:00Z')).toBe('۱ فروردین ۱۴۰۵');
    expect(formatDate('2026-03-20T20:29:00Z')).toBe('۲۹ اسفند ۱۴۰۴');
    expect(formatDateTime('2026-10-12T14:05:00Z')).toContain('۲۰ مهر ۱۴۰۵');
    expect(formatDateTime('2026-10-12T14:05:00Z')).toContain('۱۷:۳۵');
  });

  it('uses Persian digits, exact for big numbers', () => {
    expect(faDigits('id 1029')).toBe('id ۱۰۲۹');
    expect(formatNumber(12_345)).toBe('۱۲٬۳۴۵');
    expect(formatNumber(123_456_789_012_345_678_901n)).toBe('۱۲۳٬۴۵۶٬۷۸۹٬۰۱۲٬۳۴۵٬۶۷۸٬۹۰۱');
  });

  it('words durations', () => {
    expect(formatDuration(45)).toBe('۴۵ ثانیه');
    expect(formatDuration(30 * 60)).toBe('۳۰ دقیقه');
    expect(formatDuration(12 * 3600)).toBe('۱۲ ساعت');
  });
});
