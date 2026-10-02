import { GAME_TIME_ZONE } from '@lulu/config';

/**
 * Tehran calendar arithmetic using the IANA database through Intl — no hardcoded
 * offsets. A "Tehran date" is `YYYY-MM-DD`; its boundary is 00:00:00 local time.
 */

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GAME_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function wallClock(instant: number) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of Tehran wall time from UTC at `instant`, in ms. */
function offsetAt(instant: number): number {
  const w = wallClock(instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(date: string): [number, number, number] {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`no such calendar date: ${date}`);
  }
  return [y, mo, d];
}

export function isValidDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

/** The Tehran calendar date an instant falls on. */
export function tehranDate(instant: Date): string {
  const w = wallClock(instant.getTime());
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The instant of 00:00:00 Tehran time that starts `date`. */
export function tehranMidnight(date: string): Date {
  const [y, mo, d] = parseDate(date);
  const wall = Date.UTC(y, mo - 1, d);
  // Two passes resolve the offset that applies at the target instant itself.
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** The next Tehran midnight strictly after `instant`. */
export function nextTehranMidnight(instant: Date): Date {
  return tehranMidnight(addDays(tehranDate(instant), 1));
}
