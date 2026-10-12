/**
 * CSV for Excel: UTF-8 with BOM, CRLF lines, every field quoted when needed. Text that
 * came from players (names, group titles, reasons) is defused: a cell starting with
 * = + - @ or a control character would run as a formula in Excel, so it gets a leading
 * apostrophe. Amounts are plain ASCII decimals (exact, no grouping) so Excel reads them
 * as numbers.
 */

export const CSV_BOM = '﻿';

export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** For untrusted text only. */
export function safeText(value: string | null | undefined): string {
  if (!value) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export const csvLine = (fields: (string | number | null | undefined)[]) =>
  `${fields.map(csvField).join(',')}\r\n`;

/** Centi-points as exact points: 12345 → "123.45", -5 → "-0.05". */
export function pointsText(centi: bigint): string {
  const sign = centi < 0n ? '-' : '';
  const abs = centi < 0n ? -centi : centi;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

const jalali = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** «1405/07/20 17:35:00» in Tehran time, ASCII digits. */
export function jalaliDateTime(instant: Date): string {
  const p = Object.fromEntries(jalali.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Whole points with up to two decimals, optionally negative → centi; null if malformed. */
export function parsePoints(text: string): bigint | null {
  const m = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const centi = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -centi : centi;
}
