import { describe, expect, it } from 'vitest';
import { parseAmount, parseCount } from './amount.ts';

describe('parseAmount', () => {
  it.each([
    ['1000', 100_000n],
    ['۱۰۰۰', 100_000n],
    ['۱٬۰۰۰', 100_000n],
    ['1,000,000', 100_000_000n],
    ['۱۰۶۰٫۹', 106_090n],
    ['1060.9', 106_090n],
    ['0.01', 1n],
    ['  ۵۰۰ ', 50_000n],
  ])('accepts %s', (input, centi) => {
    expect(parseAmount(input)).toEqual({ ok: true, centi });
  });

  it.each([
    ['', 'empty'],
    ['-5', 'negative'],
    ['−5', 'negative'],
    ['0', 'zero'],
    ['0.00', 'zero'],
    ['1.234', 'too_precise'],
    ['1,5', 'invalid'],
    ['12,34,567', 'invalid'],
    ['1.2.3', 'invalid'],
    ['۱۰۰ پوینت', 'invalid'],
    ['1e5', 'invalid'],
    ['abc', 'invalid'],
    ['100000000000000', 'too_large'],
  ])('rejects %s as %s', (input, problem) => {
    expect(parseAmount(input)).toEqual({ ok: false, problem });
  });

  it('honours a custom maximum', () => {
    expect(parseAmount('11', 1_000n)).toEqual({ ok: false, problem: 'too_large' });
  });
});

describe('parseCount', () => {
  it('accepts whole positive counts', () => {
    expect(parseCount('۳')).toEqual({ ok: true, count: 3 });
    expect(parseCount('1,000')).toEqual({ ok: true, count: 1000 });
  });

  it('rejects fractions, zero, negatives and huge counts', () => {
    expect(parseCount('1.5')).toEqual({ ok: false, problem: 'too_precise' });
    expect(parseCount('0')).toEqual({ ok: false, problem: 'zero' });
    expect(parseCount('-2')).toEqual({ ok: false, problem: 'negative' });
    expect(parseCount('10000000')).toEqual({ ok: false, problem: 'too_large' });
  });
});
