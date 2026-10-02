import { describe, expect, it } from 'vitest';
import { normalizeText, toLatinDigits } from './normalize.ts';

/** Invisible characters are spelled as code points so the tests stay readable. */
const U = (...cps: number[]) => String.fromCodePoint(...cps);
const ZWNJ = U(0x200c);
const NBSP = U(0x00a0);
const RLM = U(0x200f);
const ZWSP = U(0x200b);
const ZWJ = U(0x200d);
const RLI = U(0x2067);
const PDI = U(0x2069);
const DAMMA = U(0x064f);
const TATWEEL = U(0x0640);

describe('normalizeText', () => {
  it('maps Arabic yeh/kaf/alef-maksura to Persian', () => {
    expect(normalizeText(U(0x0643, 0x064a, 0x0643))).toBe('کیک');
    expect(normalizeText(`مصطف${U(0x0649)}`)).toBe('مصطفی');
  });

  it('maps Persian and Arabic-Indic digits to ASCII', () => {
    expect(toLatinDigits('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890');
    expect(toLatinDigits(U(0x0660, 0x0661, 0x0662, 0x0669))).toBe('0129');
    expect(normalizeText(`واریز گنجینه ۱۰۰${U(0x0660)}`)).toBe('واریز گنجینه 1000');
  });

  it('treats ZWNJ, NBSP and repeated spaces as one space and trims', () => {
    expect(normalizeText(`روح${ZWNJ}های از یاد رفته`)).toBe('روح های از یاد رفته');
    expect(normalizeText(`  غار${NBSP}${NBSP} من \n`)).toBe('غار من');
  });

  it('strips diacritics, tatweel, zero-width and bidi control characters', () => {
    expect(normalizeText(`ل${TATWEEL}${TATWEEL}ولو`)).toBe('لولو');
    expect(normalizeText(`ل${DAMMA}ولو`)).toBe('لولو');
    expect(normalizeText(`${RLM}لولو${ZWSP}${ZWJ}`)).toBe('لولو');
    expect(normalizeText(`${RLI}لولو${PDI}`)).toBe('لولو');
  });

  it('lower-cases Latin text', () => {
    expect(normalizeText('/START@LuluBot')).toBe('/start@lulubot');
  });
});
