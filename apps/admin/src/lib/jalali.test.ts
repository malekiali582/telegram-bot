import { describe, expect, it } from 'vitest';
import { addDays, asciiDigits, dayToJalali, jalaliToDay, tehranToday } from './jalali.ts';

describe('Jalali filter dates', () => {
  it('reads Jalali dates in Persian or Latin digits', () => {
    expect(jalaliToDay('۱۴۰۵/۰۷/۲۰')).toBe('2026-10-12');
    expect(jalaliToDay('1405/7/20')).toBe('2026-10-12');
    expect(jalaliToDay(' 1405-01-01 ')).toBe('2026-03-21');
    expect(jalaliToDay('۱۴۰۴/۱۲/۲۹')).toBe('2026-03-20');
  });

  it('rejects impossible or out-of-range dates', () => {
    for (const bad of ['1405/13/01', '1405/07/32', '1404/12/30', '2026-10-12', 'دیروز', '']) {
      expect(jalaliToDay(bad), bad).toBeNull();
    }
  });

  it('writes days back in Jalali with Persian digits', () => {
    expect(dayToJalali('2026-10-12')).toBe('۱۴۰۵/۰۷/۲۰');
    expect(addDays('2026-03-20', 1)).toBe('2026-03-21');
  });

  it('knows today in Tehran, not in UTC', () => {
    expect(tehranToday(new Date('2026-10-12T20:29:00Z'))).toBe('2026-10-12');
    expect(tehranToday(new Date('2026-10-12T20:31:00Z'))).toBe('2026-10-13');
  });

  it('normalizes typed numbers', () => {
    expect(asciiDigits('۱۲٬۳۴۵٫۵')).toBe('12345.5');
    expect(asciiDigits('-٢٥')).toBe('-25');
  });
});
