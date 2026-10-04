import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';
import type { AmountProblem } from './amount.ts';
import { parseAmount, parseCount } from './amount.ts';
import type { ArgSpec, TextCommandId } from './aliases.ts';
import { COMMANDS, CURSE_ALIASES, FOOD_ALIASES, SLASH_COMMANDS, TOOL_ALIASES } from './aliases.ts';
import { normalizeText } from './normalize.ts';

export interface FoodPick {
  food: FoodKind;
  count: number;
}

type ArgsFor<S extends ArgSpec> = S extends 'amount'
  ? { amountCenti: bigint }
  : S extends 'tool'
    ? { tool: ToolKind }
    : S extends 'curse'
      ? { curse: CurseKind }
      : S extends 'food_count'
        ? FoodPick
        : S extends 'optional_food_count'
          ? { pick: FoodPick | null }
          : Record<string, never>;

export type CommandArgs = {
  [K in TextCommandId]: ArgsFor<(typeof COMMANDS)[K]['args']>;
} & {
  /** `/start <payload>`; the payload is passed through verbatim (deep-link tokens are case-sensitive). */
  start: { payload: string | null };
};

export type CommandId = keyof CommandArgs;

export type ArgProblem = AmountProblem | 'missing' | 'unknown_item';

export type ParsedCommand =
  | { [K in CommandId]: { kind: 'command'; command: K; args: CommandArgs[K] } }[CommandId]
  /**
   * Recognized command with unusable arguments: reply with usage help. `argText` is the
   * normalized text after the command word (null if there was none), so the reply can
   * say exactly what was not understood.
   */
  | { kind: 'invalid'; command: CommandId; problem: ArgProblem; argText: string | null };

export interface ParseOptions {
  /** This bot's username; `/cmd@OtherBot` is then ignored. */
  botUsername?: string;
}

interface AliasEntry<T> {
  alias: string;
  value: T;
}

/** Normalized aliases, longest first, so «خرید نفرین …» wins over «خرید …». */
function index<T>(pairs: [T, readonly string[]][]): AliasEntry<T>[] {
  return pairs
    .flatMap(([value, aliases]) => aliases.map((a) => ({ alias: normalizeText(a), value })))
    .sort((a, b) => b.alias.length - a.alias.length);
}

const COMMAND_INDEX = index(
  (Object.keys(COMMANDS) as TextCommandId[]).map((id) => [id, COMMANDS[id].aliases]),
);
const FOOD_INDEX = index(Object.entries(FOOD_ALIASES) as [FoodKind, readonly string[]][]);
const TOOL_INDEX = index(Object.entries(TOOL_ALIASES) as [ToolKind, readonly string[]][]);
const CURSE_INDEX = index(Object.entries(CURSE_ALIASES) as [CurseKind, readonly string[]][]);

/** Exposed for collision tests. */
export const ALIAS_INDEXES = {
  commands: COMMAND_INDEX,
  foods: FOOD_INDEX,
  tools: TOOL_INDEX,
  curses: CURSE_INDEX,
};

function exactItem<T>(entries: AliasEntry<T>[], text: string): T | undefined {
  return entries.find((e) => e.alias === text)?.value;
}

function parseFoodCount(text: string): FoodPick | ArgProblem {
  for (const { alias, value: food } of FOOD_INDEX) {
    let countText: string | undefined;
    if (text === alias) return { food, count: 1 };
    if (text.startsWith(`${alias} `)) countText = text.slice(alias.length + 1);
    else if (text.endsWith(` ${alias}`)) countText = text.slice(0, -alias.length - 1);
    if (countText === undefined) continue;
    const count = parseCount(countText);
    return count.ok ? { food, count: count.count } : count.problem;
  }
  return 'unknown_item';
}

type ArgResult = { ok: true; args: unknown } | { ok: false; problem: ArgProblem };

function parseArgs(spec: ArgSpec, rest: string | null): ArgResult {
  if (rest === null) {
    if (spec === 'none') return { ok: true, args: {} };
    if (spec === 'optional_food_count') return { ok: true, args: { pick: null } };
    return { ok: false, problem: 'missing' };
  }
  switch (spec) {
    case 'none':
      // Never reached: argument-less commands only match the whole message.
      return { ok: false, problem: 'missing' };
    case 'amount': {
      const amount = parseAmount(rest);
      return amount.ok
        ? { ok: true, args: { amountCenti: amount.centi } }
        : { ok: false, problem: amount.problem };
    }
    case 'tool': {
      const tool = exactItem(TOOL_INDEX, rest);
      return tool ? { ok: true, args: { tool } } : { ok: false, problem: 'unknown_item' };
    }
    case 'curse': {
      const curse = exactItem(CURSE_INDEX, rest);
      return curse ? { ok: true, args: { curse } } : { ok: false, problem: 'unknown_item' };
    }
    case 'food_count':
    case 'optional_food_count': {
      const pick = parseFoodCount(rest);
      if (typeof pick === 'string') return { ok: false, problem: pick };
      return { ok: true, args: spec === 'food_count' ? pick : { pick } };
    }
  }
}

const SLASH = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/;

function parseSlash(raw: string, options: ParseOptions): ParsedCommand | null {
  const match = SLASH.exec(raw);
  if (!match) return null;
  const [, name = '', mention, payload] = match;
  if (
    mention &&
    options.botUsername &&
    mention.toLowerCase() !== options.botUsername.toLowerCase()
  ) {
    return null;
  }
  const id = (SLASH_COMMANDS as Record<string, CommandId | undefined>)[name.toLowerCase()];
  if (id === 'start') {
    const trimmed = payload?.trim() ?? '';
    return {
      kind: 'command',
      command: 'start',
      args: { payload: trimmed === '' ? null : trimmed },
    };
  }
  if (id === 'help') return { kind: 'command', command: 'help', args: {} };
  return null;
}

/**
 * Parses one message. Returns `null` for anything that is not a command, so ordinary
 * chat (including sentences that merely contain «لولو») is ignored.
 */
export function parseCommand(text: string, options: ParseOptions = {}): ParsedCommand | null {
  const raw = text.trim();
  if (raw.startsWith('/')) return parseSlash(raw, options);

  const normalized = normalizeText(raw);
  if (normalized === '') return null;

  for (const { alias, value: command } of COMMAND_INDEX) {
    const spec: ArgSpec = COMMANDS[command].args;
    let rest: string | null;
    if (normalized === alias) rest = null;
    else if (spec !== 'none' && normalized.startsWith(`${alias} `)) {
      rest = normalized.slice(alias.length + 1);
    } else continue;

    const result = parseArgs(spec, rest);
    return result.ok
      ? ({ kind: 'command', command, args: result.args } as ParsedCommand)
      : { kind: 'invalid', command, problem: result.problem, argText: rest };
  }
  return null;
}
