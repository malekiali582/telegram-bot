import { isValidJalaaliDate, toGregorian, toJalaali } from 'jalaali-js';
import { faDigits } from './format.ts';

/**
 * Jalali dates typed into filters. The API speaks Gregorian Tehran days (YYYY-MM-DD);
 * the admin types and reads Jalali, in Persian or Latin digits.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Persian and Arabic-Indic digits → ASCII; Persian decimal and thousands marks normalized. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/[٬,]/g, '');
}

/** «۱۴۰۵/۷/۲۰», «1405-07-20» … → Gregorian «2026-10-12»; null if not a real Jalali date. */
export function jalaliToDay(text: string): string | null {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(asciiDigits(text.trim()));
  if (!m) return null;
  const [jy, jm, jd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (jy < 1390 || jy > 1500 || !isValidJalaaliDate(jy, jm, jd)) return null;
  const g = toGregorian(jy, jm, jd);
  return `${g.gy}-${pad(g.gm)}-${pad(g.gd)}`;
}

/** Gregorian «2026-10-12» → «۱۴۰۵/۰۷/۲۰». */
export function dayToJalali(day: string): string {
  const [gy, gm, gd] = day.split('-').map(Number) as [number, number, number];
  const j = toJalaali(gy, gm, gd);
  return faDigits(`${j.jy}/${pad(j.jm)}/${pad(j.jd)}`);
}

const tehranDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's Tehran calendar day as «YYYY-MM-DD». */
export function tehranToday(now: Date = new Date()): string {
  return tehranDay.format(now);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
