import { describe, expect, it } from 'vitest';
import { addDays, isValidDate, nextTehranMidnight, tehranDate, tehranMidnight } from './tehran.ts';

describe('Tehran calendar', () => {
  it('maps instants to Tehran dates around midnight (UTC+03:30 today)', () => {
    expect(tehranDate(new Date('2026-10-02T20:29:59.999Z'))).toBe('2026-10-02');
    expect(tehranDate(new Date('2026-10-02T20:30:00.000Z'))).toBe('2026-10-03');
  });

  it('finds the instant of 00:00 Tehran for a date', () => {
    expect(tehranMidnight('2026-10-03').toISOString()).toBe('2026-10-02T20:30:00.000Z');
    expect(tehranMidnight('2026-03-21').toISOString()).toBe('2026-03-20T20:30:00.000Z');
  });

  it('uses the historical rules of past dates (+04:30 in summer 2021)', () => {
    expect(tehranMidnight('2021-07-01').toISOString()).toBe('2021-06-30T19:30:00.000Z');
  });

  it('round-trips every day of a year', () => {
    let date = '2026-01-01';
    for (let i = 0; i < 365; i++) {
      const midnight = tehranMidnight(date);
      expect(tehranDate(midnight)).toBe(date);
      expect(tehranDate(new Date(midnight.getTime() - 1))).toBe(addDays(date, -1));
      date = addDays(date, 1);
    }
  });

  it('computes the next midnight strictly after an instant', () => {
    expect(nextTehranMidnight(new Date('2026-10-02T20:30:00.000Z')).toISOString()).toBe(
      '2026-10-03T20:30:00.000Z',
    );
    expect(nextTehranMidnight(new Date('2026-10-02T20:29:59.999Z')).toISOString()).toBe(
      '2026-10-02T20:30:00.000Z',
    );
  });

  it('validates calendar dates', () => {
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-2-3')).toBe(false);
    expect(() => tehranMidnight('nope')).toThrow(RangeError);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
