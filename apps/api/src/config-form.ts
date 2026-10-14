import type { ConfigChange, GameConfig } from '@lulu/config';
import { configLeaves, gameConfigSchema, ruleFor } from '@lulu/config';
import { CURSE_NAMES, FOOD_NAMES, TOOL_NAMES, levelName } from '@lulu/i18n';
import { z } from 'zod';
import type { ConfigChangeView, ConfigFieldView } from './contract.ts';

/**
 * Describes every value of the game configuration for the panel's form, straight from
 * the config schema (type, limits, choices) and the fixed/suggested rules (label and
 * Persian description). Adding a key to the schema adds a field; nothing is listed by
 * hand except Persian section titles and item names.
 */

export const SECTION_TITLES: Record<string, string> = {
  lolo: 'لولو',
  levels: 'سطح‌های بازیکن',
  food: 'وعدهٔ غذا',
  foods: 'غذاها',
  tools: 'ابزارها',
  hunt: 'شکار',
  huntingGrounds: 'شکارگاه',
  cemetery: 'قبرستان',
  city: 'لولوآباد',
  bloodBank: 'بانک خون',
  curses: 'نفرین‌ها',
  ghosts: 'روح‌ها',
  treasury: 'گنجینه',
  streak: 'استریک روزانه',
  transfer: 'انتقال',
  confirmations: 'دکمه‌های تأیید',
  admin: 'ورود و نشست پنل',
  settlement: 'تسویهٔ دوره‌ای',
  monitoring: 'هشدارهای داشبورد',
};

type JsonSchema = {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

const JSON_SCHEMA = z.toJSONSchema(gameConfigSchema, { unrepresentable: 'any' }) as JsonSchema;

const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);

/** `levels[2].upgradeCost` → ['levels', 2, 'upgradeCost'] */
function segments(path: string): (string | number)[] {
  return path
    .split(/\.|(?=\[)/)
    .map((s) => (s.startsWith('[') ? Number(s.slice(1, -1)) : s))
    .filter((s) => s !== '');
}

function schemaAt(path: (string | number)[]): JsonSchema | undefined {
  let node: JsonSchema | undefined = JSON_SCHEMA;
  for (const seg of path) {
    if (!node) return undefined;
    node = typeof seg === 'number' ? node.items : node.properties?.[seg];
  }
  return node;
}

const CHOICE_NAMES: Record<string, string> = { ...TOOL_NAMES, ...FOOD_NAMES, ...CURSE_NAMES };

/** «سطح ۳ · چاقو» — which item a leaf belongs to, read from the document itself. */
export function fieldContext(config: GameConfig, path: string): string {
  const segs = segments(path);
  const parts: string[] = [];
  let node: unknown = config;
  for (const [i, seg] of segs.entries()) {
    const parent = node;
    node = (node as Record<string | number, unknown> | undefined)?.[seg];
    if (i === segs.length - 1) break;
    if (typeof seg === 'number') {
      const item = node as { level?: unknown } | undefined;
      if (segs[0] === 'levels' && typeof item?.level === 'number') {
        parts.push(`سطح ${fa(item.level)} (${levelName(item.level)})`);
      } else if (typeof item?.level === 'number') {
        parts.push(`سطح ${fa(item.level)}`);
      } else {
        parts.push(`مرحلهٔ ${fa(seg + 1)}`);
      }
    } else if (seg in CHOICE_NAMES && parent !== config) {
      parts.push(CHOICE_NAMES[seg]!);
    }
  }
  // The last key itself names an item (e.g. weightsBp.bone, cemetery.upgradeCosts[0]).
  const last = segs.at(-1);
  if (typeof last === 'string' && last in CHOICE_NAMES && segs.length > 2)
    parts.push(CHOICE_NAMES[last]!);
  if (typeof last === 'number' && segs[0] === 'cemetery')
    parts.push(`ارتقا به سطح ${fa(last + 1)}`);
  if (typeof last === 'number' && segs[0] === 'curses') parts.push(`ارتقا به سطح ${fa(last + 1)}`);
  return parts.join(' · ');
}

function describe(path: string): {
  label: 'fixed' | 'suggested';
  description: string;
  source: string;
} {
  const rule = ruleFor(path);
  if (!rule) throw new Error(`no fixed/suggested rule for ${path}`);
  return { label: rule.label, description: rule.description, source: rule.source };
}

export function configFields(config: GameConfig): ConfigFieldView[] {
  return configLeaves(config).map(({ path, value }) => {
    const segs = segments(path);
    let node = schemaAt(segs) ?? {};
    let nullable = false;
    if (node.anyOf) {
      nullable = node.anyOf.some((s) => s.type === 'null');
      node = node.anyOf.find((s) => s.type !== 'null') ?? {};
    }
    const last = segs.at(-1);
    const structural =
      (last === 'level' && typeof segs.at(-2) === 'number') || (value === null && !node.enum);
    const choice = Array.isArray(node.enum);
    return {
      path,
      section: String(segs[0]),
      ...describe(path),
      context: fieldContext(config, path),
      kind: choice ? 'choice' : 'integer',
      ...(node.minimum !== undefined ? { min: node.minimum } : {}),
      ...(node.maximum !== undefined ? { max: node.maximum } : {}),
      ...(choice
        ? {
            options: (node.enum as string[]).map((v) => ({ value: v, name: CHOICE_NAMES[v] ?? v })),
          }
        : {}),
      nullable,
      readOnly: structural,
      basisPoints: /Bp$/.test(String(last)) || segs.includes('weightsBp'),
      value: value as number | string | null,
    };
  });
}

export function changeViews(config: GameConfig, changes: ConfigChange[]): ConfigChangeView[] {
  return changes.map((c) => ({
    path: c.path,
    label: c.label,
    description: describe(c.path).description,
    context: fieldContext(config, c.path),
    before: c.before,
    after: c.after,
  }));
}
