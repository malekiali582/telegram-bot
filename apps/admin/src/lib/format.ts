/**
 * Persian display: Solar Hijri dates in Tehran time and Persian digits. Uses the
 * browser's own ICU calendar, so no date library is needed for display.
 */

const TEHRAN = 'Asia/Tehran';
const LOCALE = 'fa-IR-u-ca-persian-nu-arabext';

const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const numberFormat = new Intl.NumberFormat('fa-IR');

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Western digits → Persian digits; everything else unchanged. */
export function faDigits(value: string | number | bigint): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!);
}

/** Exact, with Persian digits and thousands separators (bigint-safe). */
export function formatNumber(value: number | bigint): string {
  return numberFormat.format(value);
}

export function formatDate(value: string | Date): string {
  return dateFormat.format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return dateTimeFormat.format(new Date(value));
}

/** «۱۲ دقیقه» / «۳ ساعت» for a duration in seconds. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${formatNumber(Math.max(0, Math.round(seconds)))} ثانیه`;
  if (seconds < 3600) return `${formatNumber(Math.round(seconds / 60))} دقیقه`;
  return `${formatNumber(Math.round(seconds / 3600))} ساعت`;
}
