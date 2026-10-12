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

/**
 * Transaction kinds as admins see them (panel, CSV export). A test checks that every
 * kind the domain services record has a name here.
 */
export const TRANSACTION_KIND_NAMES: Readonly<Record<string, string>> = {
  lolo_reward: 'پاداش لولو',
  food_income: 'واریز غذا',
  cemetery_income: 'درآمد قبرستان',
  interest: 'سود گنجینه',
  streak_reward: 'پاداش استریک',
  ghost_heard: 'پاداش روح (شنیدم)',
  ghost_search: 'جست‌وجوی روح',
  hunt: 'شکار',
  eat: 'خوردن غذا',
  level_upgrade: 'ارتقای سطح',
  tool_purchase: 'خرید ابزار',
  cemetery_open: 'خرید قبرستان',
  cemetery_upgrade: 'ارتقای قبرستان',
  treasury_deposit: 'واریز به گنجینه',
  treasury_withdraw: 'برداشت از گنجینه',
  transfer: 'انتقال بین بازیکنان',
  blood_donation: 'اهدای خون',
  hunt_donation: 'اهدای شکار',
  city_upgrade: 'ارتقای لولوآباد',
  blood_bank_upgrade: 'ارتقای بانک خون',
  hunting_ground_upgrade: 'ارتقای شکارگاه',
  curse_upgrade: 'ارتقای نفرین',
  admin_adjustment: 'اصلاح مدیر',
};

export function transactionKindName(kind: string): string {
  return TRANSACTION_KIND_NAMES[kind] ?? kind;
}
