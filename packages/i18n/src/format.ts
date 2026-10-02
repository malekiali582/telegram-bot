/** Display formatting for Persian, RTL output. Input is never trusted: escape it. */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes user-controlled text for HTML (web panel) and Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function toPersianDigits(text: string): string {
  return text.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
}

const THOUSANDS_SEPARATOR = '٬'; // U+066C
const DECIMAL_SEPARATOR = '٫'; // U+066B

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',').replaceAll(',', THOUSANDS_SEPARATOR);
}

/** 1234567 → «۱٬۲۳۴٬۵۶۷» */
export function formatInteger(value: number | bigint): string {
  const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const sign = big < 0n ? '-' : '';
  return sign + toPersianDigits(groupDigits((big < 0n ? -big : big).toString()));
}

/**
 * Formats centi-points as LuluPoints; trailing zero decimals are dropped.
 * 106090n → «۱٬۰۶۰٫۹», 150000n → «۱٬۵۰۰»
 */
export function formatPoints(centi: bigint): string {
  const negative = centi < 0n;
  const abs = negative ? -centi : centi;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  const body = groupDigits(whole.toString()) + (frac ? DECIMAL_SEPARATOR + frac : '');
  return (negative ? '-' : '') + toPersianDigits(body);
}

/** Basis points as a percentage. 50 → «۰٫۵٪», 3000 → «۳۰٪», 575 → «۵٫۷۵٪» */
export function formatPercentBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(Math.abs(bp % 100))
    .padStart(2, '0')
    .replace(/0+$/, '');
  return toPersianDigits(String(whole) + (frac ? DECIMAL_SEPARATOR + frac : '')) + '٪';
}

/**
 * Human duration, two most significant units. Callers pass whole seconds,
 * rounded up for "time remaining" so a wait is never under-reported.
 * 250 → «۴ دقیقه و ۱۰ ثانیه», 3900 → «۱ ساعت و ۵ دقیقه»
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s === 0) return 'همین حالا';
  const units: [number, string][] = [
    [Math.floor(s / 86_400), 'روز'],
    [Math.floor((s % 86_400) / 3600), 'ساعت'],
    [Math.floor((s % 3600) / 60), 'دقیقه'],
    [s % 60, 'ثانیه'],
  ];
  const first = units.findIndex(([n]) => n > 0);
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${toPersianDigits(String(n))} ${unit}`)
    .join(' و ');
}
