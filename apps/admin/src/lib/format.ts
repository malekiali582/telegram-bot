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

const shortDayFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  month: 'long',
  day: 'numeric',
});
const compactFormat = new Intl.NumberFormat('fa-IR', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** «۲۰ مهر» for a Tehran calendar day `YYYY-MM-DD`. */
export function formatDay(day: string): string {
  // Noon UTC is the same calendar day in Tehran.
  return shortDayFormat.format(new Date(`${day}T12:00:00Z`));
}

/** «۲۰ مهر ۱۴۰۵» for a Tehran calendar day `YYYY-MM-DD`. */
export function formatDayLong(day: string): string {
  return dateFormat.format(new Date(`${day}T12:00:00Z`));
}

/** Short axis labels: «۱٫۲ هزار». */
export function formatCompact(value: number): string {
  return compactFormat.format(value);
}

/**
 * Centi-points (decimal string or bigint) as points, exact: «۱۲٬۳۴۵٫۶۷», no decimals
 * when whole.
 */
export function formatPoints(centi: string | bigint): string {
  const value = typeof centi === 'bigint' ? centi : BigInt(centi);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = formatNumber(abs / 100n);
  const fraction = abs % 100n;
  const text =
    fraction === 0n ? whole : `${whole}٫${faDigits(fraction.toString().padStart(2, '0'))}`;
  return negative ? `−${text}` : text;
}

/** Points as a plain number, for chart geometry only (never for display of exact values). */
export function pointsNumber(centi: string | bigint): number {
  return Number(typeof centi === 'bigint' ? centi : BigInt(centi)) / 100;
}

/** «۳ دقیقه پیش» / «۲ ساعت دیگر». */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const seconds = (new Date(value).getTime() - now.getTime()) / 1000;
  const size = Math.abs(seconds);
  if (size < 45) return 'همین حالا';
  const text =
    size >= 86_400 ? `${formatNumber(Math.round(size / 86_400))} روز` : formatDuration(size);
  return `${text} ${seconds < 0 ? 'پیش' : 'دیگر'}`;
}

/** Basis points as a percentage: 2380 → «۲۳٫۸٪». */
export function formatBp(bp: number): string {
  return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(bp / 100)}٪`;
}

/** Bytes as «۱٫۲ مگابایت». */
export function formatBytes(bytes: number): string {
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
