import { CURSE_KINDS, FOOD_KINDS, TOOL_KINDS } from '@lulu/config';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './aliases.ts';
import { ALIAS_INDEXES, parseCommand } from './commands.ts';
import { CURSE_NAMES, FOOD_NAMES, TOOL_NAMES } from './names.ts';
import { normalizeText } from './normalize.ts';

const cmd = (text: string) => parseCommand(text, { botUsername: 'LuluBot' });

describe('«لولو» is matched exactly, never inside a sentence', () => {
  const RLM = String.fromCodePoint(0x200f);
  const TATWEEL = String.fromCodePoint(0x0640);
  it.each(['لولو', ' لولو ', `ل${TATWEEL}ولو`, `لولو${RLM}`])('accepts %j', (text) => {
    expect(cmd(text)).toEqual({ kind: 'command', command: 'lolo', args: {} });
  });

  it.each(['لولو بده', 'سلام لولو', 'لولو!', 'لولولو', 'لولو.', 'لو لو'])('ignores %j', (text) => {
    expect(cmd(text)).toBeNull();
  });
});

describe('argument-less commands', () => {
  it('does not confuse commands that share a prefix', () => {
    expect(cmd('شکار')).toMatchObject({ command: 'hunt' });
    expect(cmd('شکارگاه')).toMatchObject({ command: 'hunting_ground' });
    expect(cmd('ابزار شکار')).toMatchObject({ command: 'tool_shop' });
    expect(cmd('لولو آباد')).toMatchObject({ command: 'city' });
    expect(cmd('لولوآباد')).toMatchObject({ command: 'city' });
    expect(cmd('بانک خون')).toMatchObject({ command: 'blood_bank' });
    expect(cmd('ارتقای بانک خون')).toMatchObject({ command: 'blood_bank_upgrade' });
  });

  it('accepts aliases with Arabic letters, ZWNJ or spaces', () => {
    expect(cmd('قبرستان')).toMatchObject({ command: 'cemetery' });
    expect(cmd('قبرستون')).toMatchObject({ command: 'cemetery' });
    expect(cmd('روح‌های از یاد رفته')).toMatchObject({ command: 'ghost_search' });
    expect(cmd('روح های از یاد رفته')).toMatchObject({ command: 'ghost_search' });
    expect(cmd('جست‌وجوی روح')).toMatchObject({ command: 'ghost_search' });
    expect(cmd('ترسناك‌ترين لولوها')).toMatchObject({ command: 'leaderboard' });
    expect(cmd('لولوی من')).toMatchObject({ command: 'cave' });
  });

  it('ignores trailing words after an argument-less command', () => {
    expect(cmd('شکار کن')).toBeNull();
    expect(cmd('شنیدم بابا')).toBeNull();
  });
});

describe('commands with arguments', () => {
  it('parses amounts into centi-points', () => {
    expect(cmd('واریز گنجینه ۱٬۰۰۰')).toEqual({
      kind: 'command',
      command: 'treasury_deposit',
      args: { amountCenti: 100_000n },
    });
    expect(cmd('برداشت از گنجینه 1060.9')).toEqual({
      kind: 'command',
      command: 'treasury_withdraw',
      args: { amountCenti: 106_090n },
    });
  });

  it('reports bad or missing amounts as invalid instead of ignoring them', () => {
    expect(cmd('انتقال')).toEqual({
      kind: 'invalid',
      command: 'transfer',
      problem: 'missing',
      argText: null,
    });
    expect(cmd('انتقال -50')).toEqual({
      kind: 'invalid',
      command: 'transfer',
      problem: 'negative',
      argText: '-50',
    });
    expect(cmd('اهدای خون صفر')).toEqual({
      kind: 'invalid',
      command: 'donate_blood',
      problem: 'invalid',
      argText: 'صفر',
    });
  });

  it('keeps the argument text of an invalid amount so the reply can quote it', () => {
    for (const [text, problem, argText] of [
      ['انتقال 50 لولو', 'invalid', '50 لولو'],
      ['انتقال ۵۰ @someone', 'invalid', '50 @someone'],
      ['انتقال 0', 'zero', '0'],
      ['انتقال ۱۰۰۰۰۰۰۰۰۰۰۰۰۰۰', 'too_large', '100000000000000'],
    ] as const) {
      expect(cmd(text)).toEqual({ kind: 'invalid', command: 'transfer', problem, argText });
    }
  });

  it('parses food and count in either order, defaulting the count to 1', () => {
    expect(cmd('خوردن استخون ۳')).toEqual({
      kind: 'command',
      command: 'eat',
      args: { pick: { food: 'bone', count: 3 } },
    });
    expect(cmd('خوردن ۳ استخوان')).toEqual({
      kind: 'command',
      command: 'eat',
      args: { pick: { food: 'bone', count: 3 } },
    });
    expect(cmd('اهدای شکار موش')).toEqual({
      kind: 'command',
      command: 'donate_hunt',
      args: { food: 'mouse', count: 1 },
    });
    expect(cmd('خوردن')).toEqual({ kind: 'command', command: 'eat', args: { pick: null } });
    expect(cmd('اهدای شکار')).toMatchObject({ kind: 'invalid', problem: 'missing' });
    expect(cmd('خوردن پیتزا')).toMatchObject({ kind: 'invalid', problem: 'unknown_item' });
    expect(cmd('خوردن موش ۱٫۵')).toMatchObject({ kind: 'invalid', problem: 'too_precise' });
  });

  it('picks the longest alias: «خرید نفرین» is a curse, «خرید» a tool', () => {
    expect(cmd('خرید نفرین شتاب شکار')).toEqual({
      kind: 'command',
      command: 'curse_upgrade',
      args: { curse: 'hunt_haste' },
    });
    expect(cmd('خرید چوب جادویی')).toEqual({
      kind: 'command',
      command: 'tool_buy',
      args: { tool: 'magic_wand' },
    });
    expect(cmd('خرید ابزار تیر و کمان')).toEqual({
      kind: 'command',
      command: 'tool_buy',
      args: { tool: 'bow' },
    });
    // Equipping is automatic (the strongest owned tool), so there is no such command.
    expect(cmd('تجهیز چاقو')).toBeNull();
    expect(cmd('تجهیز ابزار تبر')).toBeNull();
    expect(cmd('خرید موشک')).toMatchObject({ kind: 'invalid', problem: 'unknown_item' });
  });
});

describe('slash commands', () => {
  it('parses /start with an optional case-preserving payload', () => {
    expect(cmd('/start')).toEqual({ kind: 'command', command: 'start', args: { payload: null } });
    expect(cmd('/start@LuluBot AbC-123')).toEqual({
      kind: 'command',
      command: 'start',
      args: { payload: 'AbC-123' },
    });
    expect(cmd('/help@lulubot')).toEqual({ kind: 'command', command: 'help', args: {} });
  });

  it('ignores commands addressed to another bot and unknown slash commands', () => {
    expect(cmd('/start@OtherBot')).toBeNull();
    expect(cmd('/hunt')).toBeNull();
    expect(cmd('/')).toBeNull();
  });
});

describe('alias table integrity', () => {
  it('has no collisions after normalization', () => {
    for (const [name, entries] of Object.entries(ALIAS_INDEXES)) {
      const seen = new Map<string, unknown>();
      for (const { alias, value } of entries) {
        expect(seen.get(alias) ?? value, `${name}: «${alias}»`).toBe(value);
        seen.set(alias, value);
      }
    }
  });

  it('every alias is non-empty and has no leading slash', () => {
    for (const entries of Object.values(ALIAS_INDEXES)) {
      for (const { alias } of entries) {
        expect(alias.length).toBeGreaterThan(0);
        expect(alias.startsWith('/')).toBe(false);
      }
    }
  });

  it('covers every food, tool and curse, and their display names parse back', () => {
    const covered = (entries: { value: string }[]) => new Set(entries.map((e) => e.value));
    expect(covered(ALIAS_INDEXES.foods)).toEqual(new Set(FOOD_KINDS));
    expect(covered(ALIAS_INDEXES.tools)).toEqual(new Set(TOOL_KINDS));
    expect(covered(ALIAS_INDEXES.curses)).toEqual(new Set(CURSE_KINDS));
    for (const kind of FOOD_KINDS) {
      expect(cmd(`خوردن ${FOOD_NAMES[kind]}`)).toMatchObject({ args: { pick: { food: kind } } });
    }
    for (const kind of TOOL_KINDS) {
      expect(cmd(`خرید ${TOOL_NAMES[kind]}`)).toMatchObject({ args: { tool: kind } });
    }
    for (const kind of CURSE_KINDS) {
      expect(cmd(`ارتقای نفرین ${CURSE_NAMES[kind]}`)).toMatchObject({ args: { curse: kind } });
    }
  });

  it('every command parses from each of its own aliases', () => {
    for (const [id, spec] of Object.entries(COMMANDS)) {
      for (const alias of spec.aliases) {
        const parsed = cmd(alias);
        expect(parsed?.command, `«${alias}»`).toBe(id);
        expect(normalizeText(alias)).not.toBe('');
      }
    }
  });
});
