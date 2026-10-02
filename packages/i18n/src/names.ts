import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';

/** Display names. Typed aliases for user input live in `aliases.ts`. */

export const LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: 'روح',
  2: 'اسکلت',
  3: 'زامبی',
  4: 'دیو',
  5: 'گرگینه',
  6: 'خون‌آشام',
};

export function levelName(level: number): string {
  return LEVEL_NAMES[level] ?? `سطح ${level}`;
}

export const FOOD_NAMES: Readonly<Record<FoodKind, string>> = {
  bone: 'استخوان',
  mouse: 'موش',
  chicken: 'مرغ',
  pig: 'خوک',
  sheep: 'گوسفند',
  cow: 'گاو',
  deer: 'گوزن',
  human: 'انسان',
};

export const TOOL_NAMES: Readonly<Record<ToolKind, string>> = {
  knife: 'چاقو',
  axe: 'تبر',
  sword: 'شمشیر',
  bow: 'کمان',
  magic_wand: 'چوب جادو',
};

export const CURSE_NAMES: Readonly<Record<CurseKind, string>> = {
  hunt_haste: 'شتاب شکار',
  lolo_echo: 'پژواک لولو',
};
