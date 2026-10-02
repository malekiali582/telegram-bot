import { normalizeText } from './normalize.ts';

export type AmountProblem = 'empty' | 'invalid' | 'negative' | 'zero' | 'too_precise' | 'too_large';

export type AmountResult = { ok: true; centi: bigint } | { ok: false; problem: AmountProblem };
export type CountResult = { ok: true; count: number } | { ok: false; problem: AmountProblem };

/** Upper bound for a single typed amount: 10^13 points. */
export const MAX_AMOUNT_CENTI = 10n ** 15n;
export const MAX_COUNT = 1_000_000;

// Thousands separators: ASCII comma, Arabic thousands separator «٬», Arabic comma «،».
const THOUSANDS = /[,٬،]/;
// Decimal separators: ASCII dot, Arabic decimal separator «٫».
const DECIMAL = /[.٫]/;

function splitNumber(raw: string): { int: string; frac: string } | AmountProblem {
  const text = normalizeText(raw);
  if (text === '') return 'empty';
  if (/^[-−]/.test(text)) return 'negative';

  const parts = text.split(DECIMAL);
  if (parts.length > 2) return 'invalid';
  const [intPart = '', frac = ''] = parts;

  let int = intPart;
  if (THOUSANDS.test(intPart)) {
    // Grouping must be well-formed so «1,5» is not silently read as 15.
    const groups = intPart.split(new RegExp(THOUSANDS.source, 'g'));
    const [first = '', ...rest] = groups;
    if (!/^\d{1,3}$/.test(first) || !rest.every((g) => /^\d{3}$/.test(g))) return 'invalid';
    int = groups.join('');
  }
  if (!/^\d+$/.test(int)) return 'invalid';
  if (parts.length === 2 && !/^\d+$/.test(frac)) return 'invalid';
  return { int, frac };
}

/**
 * Parses a user-typed LuluPoint amount into centi-points. Accepts Persian/Arabic
 * digits, well-formed thousands grouping and at most two decimals.
 */
export function parseAmount(raw: string, maxCenti: bigint = MAX_AMOUNT_CENTI): AmountResult {
  const split = splitNumber(raw);
  if (typeof split === 'string') return { ok: false, problem: split };
  if (split.frac.length > 2) return { ok: false, problem: 'too_precise' };
  const centi = BigInt(split.int) * 100n + BigInt(split.frac.padEnd(2, '0'));
  if (centi === 0n) return { ok: false, problem: 'zero' };
  if (centi > maxCenti) return { ok: false, problem: 'too_large' };
  return { ok: true, centi };
}

/** Parses a positive whole item count. */
export function parseCount(raw: string, max: number = MAX_COUNT): CountResult {
  const split = splitNumber(raw);
  if (typeof split === 'string') return { ok: false, problem: split };
  if (split.frac !== '' && /[1-9]/.test(split.frac)) return { ok: false, problem: 'too_precise' };
  const count = BigInt(split.int);
  if (count === 0n) return { ok: false, problem: 'zero' };
  if (count > BigInt(max)) return { ok: false, problem: 'too_large' };
  return { ok: true, count: Number(count) };
}
