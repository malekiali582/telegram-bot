import { describe, expect, it } from 'vitest';
import {
  faDigits,
  formatBp,
  formatDate,
  formatDateTime,
  formatDay,
  formatDuration,
  formatNumber,
  formatPoints,
  formatRelative,
  formatSignedPoints,
} from './format.ts';

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

describe('points, percentages and relative time', () => {
  it('shows exact points from centi-point strings, beyond 2^53', () => {
    expect(formatPoints('12345')).toBe('۱۲۳٫۴۵');
    expect(formatPoints('1200')).toBe('۱۲');
    expect(formatPoints('5')).toBe('۰٫۰۵');
    expect(formatPoints('-30000')).toBe('−۳۰۰');
    expect(formatPoints('123456789012345678901')).toBe('۱٬۲۳۴٬۵۶۷٬۸۹۰٬۱۲۳٬۴۵۶٬۷۸۹٫۰۱');
  });

  it('words percentages, days and relative times', () => {
    expect(formatBp(2380)).toBe('۲۳٫۸٪');
    expect(formatDay('2026-10-12')).toBe('۲۰ مهر');
    const now = new Date('2026-10-12T12:00:00Z');
    expect(formatRelative('2026-10-12T11:57:00Z', now)).toBe('۳ دقیقه پیش');
    expect(formatRelative('2026-10-12T12:00:20Z', now)).toBe('همین حالا');
    expect(formatRelative('2026-10-12T14:00:00Z', now)).toBe('۲ ساعت دیگر');
    expect(formatRelative('2026-10-09T12:00:00Z', now)).toBe('۳ روز پیش');
  });
});

describe('signed amounts', () => {
  it('keep their sign on the left inside Persian text', () => {
    const isolate = (s: string) =>
      `${String.fromCodePoint(0x2066)}${s}${String.fromCodePoint(0x2069)}`;
    expect(formatSignedPoints('1250')).toBe(isolate('+۱۲٫۵۰'));
    expect(formatSignedPoints('-30000')).toBe(isolate('−۳۰۰'));
    expect(formatSignedPoints('0')).toBe(isolate('۰'));
  });
});
