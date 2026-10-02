/**
 * Input normalization for command matching. Matching is always exact on the
 * normalized form; there is no fuzzy matching on whole messages.
 *
 * Character classes are built from numeric code points on purpose: most of these
 * characters are invisible, and literal or escaped forms are easy to corrupt.
 */

type Range = readonly [from: number, to?: number];

function charClass(ranges: readonly Range[]): RegExp {
  const hex = (cp: number) => `\\u{${cp.toString(16)}}`;
  const body = ranges.map(([from, to]) => (to ? `${hex(from)}-${hex(to)}` : hex(from))).join('');
  return new RegExp(`[${body}]`, 'gu');
}

const ch = (cp: number) => String.fromCodePoint(cp);

const ZWNJ = 0x200c; // نیم‌فاصله

/** Arabic letter forms → Persian; ZWNJ → space so «روح‌ها» ≡ «روح ها». */
const CHAR_MAP = new Map<string, string>([
  [ch(0x064a), ch(0x06cc)], // ARABIC YEH → FARSI YEH
  [ch(0x0649), ch(0x06cc)], // ALEF MAKSURA → FARSI YEH
  [ch(0x0643), ch(0x06a9)], // ARABIC KAF → KEHEH
  [ch(ZWNJ), ' '],
]);
const MAPPED = charClass([[0x064a], [0x0649], [0x0643], [ZWNJ]]);

const STRIP = charClass([
  [0x064b, 0x065f], // harakat: fathatan … wavy hamza below
  [0x0670], // superscript alef
  [0x0640], // tatweel
  [0x200b], // zero width space
  [0x200d], // zero width joiner
  [0x200e, 0x200f], // LRM, RLM
  [0x061c], // arabic letter mark
  [0x202a, 0x202e], // bidi embeddings/overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff], // BOM / zero width no-break space
]);

const PERSIAN_DIGITS = charClass([[0x06f0, 0x06f9]]);
const ARABIC_DIGITS = charClass([[0x0660, 0x0669]]);
const SPACES = charClass([[0x00a0], [0x2007], [0x202f]]);

export function toLatinDigits(input: string): string {
  return input
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * - Arabic ي/ى/ك → Persian ی/ک
 * - Persian/Arabic-Indic digits → ASCII digits
 * - diacritics, tatweel, zero-width and direction marks removed
 * - ZWNJ, NBSP and runs of whitespace → one ASCII space; trimmed
 * - Latin letters lower-cased (for `/start@BotName`)
 */
export function normalizeText(input: string): string {
  return toLatinDigits(
    input
      .normalize('NFC')
      .replace(STRIP, '')
      .replace(MAPPED, (c) => CHAR_MAP.get(c) ?? c),
  )
    .replace(SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
