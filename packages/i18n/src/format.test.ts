import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatDuration,
  formatInteger,
  formatPercentBp,
  formatPoints,
  toPersianDigits,
} from './format.ts';
import { helpText } from './help.ts';
import { levelName } from './names.ts';

describe('escapeHtml', () => {
  it('neutralizes markup in untrusted names', () => {
    expect(escapeHtml('<b>"Ali" & \'Co\'</b>')).toBe(
      '&lt;b&gt;&quot;Ali&quot; &amp; &#39;Co&#39;&lt;/b&gt;',
    );
    expect(escapeHtml('<a href="javascript:x">')).not.toContain('<');
  });
});

describe('number formatting', () => {
  it('uses Persian digits and the Arabic thousands separator', () => {
    expect(toPersianDigits('2026')).toBe('۲۰۲۶');
    expect(formatInteger(18_000_000)).toBe('۱۸٬۰۰۰٬۰۰۰');
    expect(formatInteger(-1500n)).toBe('-۱٬۵۰۰');
    expect(formatInteger(999)).toBe('۹۹۹');
  });

  it('formats centi-points, dropping zero decimals', () => {
    expect(formatPoints(103_000n)).toBe('۱٬۰۳۰');
    expect(formatPoints(106_090n)).toBe('۱٬۰۶۰٫۹');
    expect(formatPoints(5n)).toBe('۰٫۰۵');
    expect(formatPoints(0n)).toBe('۰');
    expect(formatPoints(-250n)).toBe('-۲٫۵');
  });

  it('formats basis points as percentages', () => {
    expect(formatPercentBp(50)).toBe('۰٫۵٪');
    expect(formatPercentBp(300)).toBe('۳٪');
    expect(formatPercentBp(575)).toBe('۵٫۷۵٪');
    expect(formatPercentBp(10_000)).toBe('۱۰۰٪');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, 'همین حالا'],
    [-3, 'همین حالا'],
    [0.2, '۱ ثانیه'],
    [59, '۵۹ ثانیه'],
    [250, '۴ دقیقه و ۱۰ ثانیه'],
    [300, '۵ دقیقه'],
    [3900, '۱ ساعت و ۵ دقیقه'],
    [3605, '۱ ساعت'],
    [90_000, '۱ روز و ۱ ساعت'],
  ])('%d s → %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe('names and help', () => {
  it('names all six levels', () => {
    expect([1, 2, 3, 4, 5, 6].map(levelName)).toEqual([
      'روح',
      'اسکلت',
      'زامبی',
      'دیو',
      'گرگینه',
      'خون‌آشام',
    ]);
  });

  it('builds a categorized help text that lists every primary command', () => {
    const help = helpText();
    for (const word of ['لولو', 'شکار', 'گنجینه', 'لولوآباد', 'جستجوی روح', 'شنیدم', 'انتقال']) {
      expect(help).toContain(word);
    }
    expect(help.length).toBeLessThan(4096);
  });
});
