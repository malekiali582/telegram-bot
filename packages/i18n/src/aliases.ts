import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';

/**
 * The single place where user-typed phrases are defined (spec §16). Colloquial
 * variants are added here only; game logic never compares raw strings.
 * Aliases are written naturally (with ZWNJ etc.) and normalized when loaded.
 */

export type ArgSpec =
  /** Exact whole-message match only. */
  | 'none'
  /** `<amount>` in LuluPoints. */
  | 'amount'
  | 'tool'
  | 'curse'
  /** `<food> [count]`, count defaults to 1; either order. */
  | 'food_count'
  /** Nothing (show a picker) or `<food> [count]`. */
  | 'optional_food_count';

export interface CommandSpec {
  aliases: readonly string[];
  args: ArgSpec;
  /** Persian one-line description used by the help text. */
  help: string;
  helpGroup: HelpGroup;
}

export type HelpGroup = 'basics' | 'hunt' | 'assets' | 'city' | 'ghosts';

export const COMMANDS = {
  lolo: { aliases: ['لولو'], args: 'none', help: 'پاداش (هر ۵ دقیقه)', helpGroup: 'basics' },
  balance: {
    aliases: ['لولوهام', 'سکه‌هام', 'موجودی'],
    args: 'none',
    help: 'موجودی نقدی و گنجینه',
    helpGroup: 'basics',
  },
  cave: {
    aliases: ['غار من', 'لولوی من'],
    args: 'none',
    help: 'پروفایل و همهٔ دارایی‌ها',
    helpGroup: 'basics',
  },
  level_upgrade: {
    aliases: ['ارتقای لولو', 'ارتقا لولو', 'ارتقاء لولو'],
    args: 'none',
    help: 'خرید سطح بعد',
    helpGroup: 'basics',
  },
  leaderboard: {
    aliases: ['ترسناک‌ترین لولوها', 'ترسناکترین لولوها'],
    args: 'none',
    help: 'رتبه‌بندی بر اساس لولوپوینت',
    helpGroup: 'basics',
  },
  help: { aliases: ['راهنما'], args: 'none', help: 'همین راهنما', helpGroup: 'basics' },

  tool_shop: {
    aliases: ['ابزار شکار', 'ابزارها'],
    args: 'none',
    help: 'فروشگاه ابزار (قوی‌ترین ابزار خودکار استفاده می‌شود)',
    helpGroup: 'hunt',
  },
  tool_buy: {
    aliases: ['خرید ابزار', 'خرید'],
    args: 'tool',
    help: 'خرید ابزار: «خرید چاقو»',
    helpGroup: 'hunt',
  },
  hunt: { aliases: ['شکار'], args: 'none', help: 'تلاش شکار (هر ساعت)', helpGroup: 'hunt' },
  cellar: { aliases: ['سرداب'], args: 'none', help: 'موجودی شکارها', helpGroup: 'hunt' },
  eat: {
    aliases: ['خوردن', 'بخور'],
    args: 'optional_food_count',
    help: 'خوردن غذا: «خوردن استخوان ۲»',
    helpGroup: 'hunt',
  },

  cemetery: {
    aliases: ['قبرستون', 'قبرستان'],
    args: 'none',
    help: 'افتتاح، درآمد و ارتقای قبرستان',
    helpGroup: 'assets',
  },
  treasury: { aliases: ['گنجینه'], args: 'none', help: 'سپرده و سود روزانه', helpGroup: 'assets' },
  treasury_deposit: {
    aliases: ['واریز گنجینه', 'واریز به گنجینه'],
    args: 'amount',
    help: 'واریز به گنجینه: «واریز گنجینه ۱۰۰۰»',
    helpGroup: 'assets',
  },
  treasury_withdraw: {
    aliases: ['برداشت گنجینه', 'برداشت از گنجینه'],
    args: 'amount',
    help: 'برداشت از گنجینه: «برداشت گنجینه ۵۰۰»',
    helpGroup: 'assets',
  },
  transfer: {
    aliases: ['انتقال'],
    args: 'amount',
    help: 'روی پیام گیرنده reply کنید: «انتقال ۱۰۰»',
    helpGroup: 'assets',
  },

  city: {
    aliases: ['لولوآباد', 'لولو آباد'],
    args: 'none',
    help: 'وضعیت پنج ستون گروه',
    helpGroup: 'city',
  },
  blood_bank: {
    aliases: ['بانک خون'],
    args: 'none',
    help: 'خزانهٔ گروه و سطح بانک',
    helpGroup: 'city',
  },
  donate_blood: {
    aliases: ['اهدای خون'],
    args: 'amount',
    help: 'کمک پوینت به گروه: «اهدای خون ۵۰۰»',
    helpGroup: 'city',
  },
  donate_hunt: {
    aliases: ['اهدای شکار'],
    args: 'food_count',
    help: 'کمک شکار به گروه: «اهدای شکار موش ۳»',
    helpGroup: 'city',
  },
  city_upgrade: {
    aliases: ['ارتقای آبادی', 'ارتقا آبادی'],
    args: 'none',
    help: 'ارتقای آبادی (مدیر گروه)',
    helpGroup: 'city',
  },
  blood_bank_upgrade: {
    aliases: ['ارتقای بانک خون', 'ارتقا بانک خون'],
    args: 'none',
    help: 'ارتقای بانک خون (مدیر گروه)',
    helpGroup: 'city',
  },
  hunting_ground: {
    aliases: ['شکارگاه'],
    args: 'none',
    help: 'سطح و جدول شکارگاه',
    helpGroup: 'city',
  },
  hunting_ground_upgrade: {
    aliases: ['ارتقای شکارگاه', 'ارتقا شکارگاه'],
    args: 'none',
    help: 'ارتقای شکارگاه (مدیر گروه)',
    helpGroup: 'city',
  },
  curses: {
    aliases: ['نفرین‌ها', 'نفرینها'],
    args: 'none',
    help: 'نفرین‌های گروه',
    helpGroup: 'city',
  },
  curse_upgrade: {
    aliases: ['ارتقای نفرین', 'ارتقا نفرین', 'خرید نفرین'],
    args: 'curse',
    help: 'ارتقای نفرین (مدیر گروه): «ارتقای نفرین شتاب شکار»',
    helpGroup: 'city',
  },

  ghost_search: {
    aliases: [
      'جستجوی روح',
      'جست‌وجوی روح',
      'جست و جوی روح',
      'روح‌های از یاد رفته',
      'روحهای از یاد رفته',
    ],
    args: 'none',
    help: 'جست‌وجوی روح‌های از یاد رفته',
    helpGroup: 'ghosts',
  },
  heard: {
    aliases: ['شنیدم'],
    args: 'none',
    help: 'روی پیام روح خودتان reply کنید',
    helpGroup: 'ghosts',
  },
} as const satisfies Record<string, CommandSpec>;

export type TextCommandId = keyof typeof COMMANDS;

/** Slash commands are platform menu shortcuts; only these are recognized. */
export const SLASH_COMMANDS = {
  start: 'start',
  help: 'help',
} as const satisfies Record<string, 'start' | TextCommandId>;

export const FOOD_ALIASES: Readonly<Record<FoodKind, readonly string[]>> = {
  bone: ['استخوان', 'استخون'],
  mouse: ['موش'],
  chicken: ['مرغ'],
  pig: ['خوک'],
  sheep: ['گوسفند'],
  cow: ['گاو'],
  deer: ['گوزن'],
  human: ['انسان', 'آدم'],
};

export const TOOL_ALIASES: Readonly<Record<ToolKind, readonly string[]>> = {
  knife: ['چاقو'],
  axe: ['تبر'],
  sword: ['شمشیر'],
  bow: ['کمان', 'تیر و کمان'],
  magic_wand: ['چوب جادو', 'چوب جادویی'],
};

export const CURSE_ALIASES: Readonly<Record<CurseKind, readonly string[]>> = {
  hunt_haste: ['شتاب شکار'],
  lolo_echo: ['پژواک لولو'],
};
