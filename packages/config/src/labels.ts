import type { GameConfig } from './schema.ts';

/**
 * `fixed`: an explicit owner rule — changing it requires explicit owner approval in the panel.
 * `suggested`: a version-1 starting value — any panel admin may change it (validated, versioned).
 */
export type ConfigLabel = 'fixed' | 'suggested';

export interface LabelRule {
  /**
   * Dot path over the config. `[]` stands for any array index, `*` for any single
   * object key. Rules are matched in order; the first match wins.
   */
  pattern: string;
  label: ConfigLabel;
  /** Persian description shown in the admin panel. */
  description: string;
  /** Section of PROMPT.md the rule or value comes from. */
  source: string;
}

const fixed = (pattern: string, description: string, source: string): LabelRule => ({
  pattern,
  label: 'fixed',
  description,
  source,
});
const suggested = (pattern: string, description: string, source: string): LabelRule => ({
  pattern,
  label: 'suggested',
  description,
  source,
});

export const LABEL_RULES: readonly LabelRule[] = [
  fixed('lolo.cooldownSeconds', 'زمان انتظار پایهٔ لولو (ثانیه)، مشترک بین گروه‌ها', '§5'),
  suggested('lolo.waitNoticeThrottleSeconds', 'حداقل فاصلهٔ پیام «زمان باقی‌مانده» (ثانیه)', '§5'),

  fixed('levels[].level', 'شمارهٔ سطح (ساختاری)', '§5'),
  fixed('levels[].rewardMin', 'کمینهٔ پاداش پایهٔ لولو در سطح', '§5'),
  fixed('levels[].rewardMax', 'بیشینهٔ پاداش پایهٔ لولو در سطح', '§5'),
  fixed('levels[].mealCapacity', 'ظرفیت وعدهٔ هم‌زمان فعال', '§5, §2.6'),
  suggested('levels[].upgradeCost', 'هزینهٔ رفتن به سطح بعد (پوینت)', '§5'),

  fixed(
    'food.pointsPerNutritionPerSecond',
    'پوینت در ثانیه به ازای هر واحد ارزش غذایی',
    '§9, §2.2',
  ),
  fixed('food.mealDurationSeconds', 'مدت فعال بودن هر وعده (ثانیه)', '§9, §2.2'),
  fixed('food.claimWindowSeconds', 'بیشینهٔ پنجرهٔ دریافت پاداش غذا (ثانیه)', '§9, §2.3'),

  suggested('foods.human.nutrition', 'ارزش غذایی انسان', '§8, §2.4'),
  fixed('foods.*.nutrition', 'ارزش غذایی', '§8'),
  fixed('foods.*.minLevel', 'حداقل سطح شخصیت برای شکار این غذا', '§8'),
  fixed('foods.*.requiredTool', 'ابزار لازم برای شکار این غذا', '§8'),

  suggested('tools.*.price', 'قیمت ابزار (پوینت)', '§7'),
  suggested('tools.*.successBp', 'احتمال موفقیت شکار با این ابزار (bp)', '§7'),

  fixed('hunt.minLevel', 'حداقل سطح برای شکار', '§2.6'),
  fixed('hunt.cooldownSeconds', 'زمان انتظار پایهٔ شکار (ثانیه)، مشترک بین گروه‌ها', '§8'),

  fixed('huntingGrounds[].level', 'شمارهٔ سطح شکارگاه (ساختاری)', '§8'),
  suggested('huntingGrounds[].weightsBp.*', 'احتمال شرطی نوع شکار در این شکارگاه (bp)', '§8'),
  suggested('huntingGrounds[].upgradeCost', 'هزینهٔ ارتقای شکارگاه از بانک خون', '§11'),

  fixed('cemetery.openCost', 'هزینهٔ افتتاح قبرستان', '§10, §2.5'),
  fixed('cemetery.baseHourlyIncome', 'درآمد پایهٔ قبرستان در ساعت', '§10, §2.5'),
  fixed('cemetery.levelBonusBp', 'افزایش خطی درآمد در هر سطح نسبت به پایه (bp)', '§10'),
  fixed('cemetery.maxLevel', 'سقف سطح قبرستان', '§10'),
  suggested('cemetery.upgradeCosts[]', 'هزینهٔ ارتقای قبرستان', '§10'),

  fixed('city.levels[].level', 'شمارهٔ سطح آبادی (ساختاری)', '§11'),
  suggested('city.activePopulationWindowDays', 'بازهٔ روزهای فعالیت برای جمعیت فعال', '§11'),
  suggested('city.levels[].requiredActivePopulation', 'جمعیت فعال لازم برای ارتقای آبادی', '§11'),
  suggested('city.levels[].bloodBankCost', 'هزینهٔ ارتقای آبادی از بانک خون', '§11'),
  suggested('city.levels[].huntPointsCost', 'ارزش شکار مصرفی برای ارتقای آبادی', '§11'),

  fixed('bloodBank.levels[].level', 'شمارهٔ سطح بانک خون (ساختاری)', '§11'),
  suggested('bloodBank.levels[].upgradeCost', 'هزینهٔ ارتقای بانک خون از موجودی خود بانک', '§11'),
  suggested('bloodBank.levels[].maxHuntingGroundLevel', 'سقف سطح شکارگاه در این سطح بانک', '§11'),
  suggested('bloodBank.levels[].maxCurseLevel', 'سقف سطح هر نفرین در این سطح بانک', '§11'),

  suggested('curses.*.reductionPerLevelBp', 'کاهش خطی زمان انتظار در هر سطح نفرین (bp)', '§11'),
  suggested('curses.*.levelCosts[]', 'هزینهٔ خرید هر سطح نفرین از بانک خون', '§11'),

  fixed('ghosts.baseChanceBp', 'شانس پایهٔ پیدا کردن روح در آبادی سطح ۱ (bp)', '§12, §2.1'),
  suggested('ghosts.cityLevelBonusBp', 'افزایش شانس روح به ازای هر سطح آبادی (bp)', '§12'),
  fixed('ghosts.failureMultiplierBp', 'ضریب شانس پس از هر شکست متوالی (bp)', '§12'),
  fixed('ghosts.minChanceBp', 'کف شانس پیدا کردن روح (bp)', '§12'),
  fixed('ghosts.dailyLimit', 'سقف روح پیداشده در روز تهران، در مجموع گروه‌ها', '§12'),
  suggested('ghosts.cooldownSeconds', 'زمان انتظار بین تلاش‌های جست‌وجوی روح (ثانیه)', '§12'),
  suggested('ghosts.fearMin', 'کمینهٔ پاداش ترس هر روح', '§12'),
  suggested('ghosts.fearMax', 'بیشینهٔ پاداش ترس هر روح', '§12'),
  suggested('ghosts.replyDeadlineHours', 'مهلت پاسخ «شنیدم» از لحظهٔ کشف (ساعت)', '§12'),
  fixed('ghosts.batchSize', 'تعداد متن هر بستهٔ روزانه', '§13'),

  fixed('treasury.dailyInterestBp', 'سود مرکب روزانهٔ گنجینه در نیمه‌شب تهران (bp)', '§14'),
  fixed('transfer.feeBp', 'کارمزد انتقال بین بازیکنان (bp)', '§14'),

  suggested('confirmations.ttlSeconds', 'مهلت دکمه‌های تأیید (ثانیه)', 'B-2'),
  suggested('admin.*', 'تنظیمات ورود و نشست پنل', 'B-2'),
];

export interface ConfigLeaf {
  /** Concrete path, e.g. `levels[2].upgradeCost`. */
  path: string;
  value: unknown;
}

/** Flattens a config document into its leaf values. */
export function configLeaves(value: unknown, prefix = ''): ConfigLeaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => configLeaves(item, `${prefix}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      configLeaves(child, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [{ path: prefix, value }];
}

/** `levels[2].upgradeCost` → `levels[].upgradeCost` */
export function normalizeConfigPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

/** Matches a normalized path against a rule pattern (`*` = one object key). */
export function patternMatches(pattern: string, normalizedPath: string): boolean {
  const p = pattern.split('.');
  const s = normalizedPath.split('.');
  if (p.length !== s.length) return false;
  return p.every((seg, i) => {
    const target = s[i] ?? '';
    if (seg === '*') return !target.endsWith('[]');
    return seg === target;
  });
}

export function ruleFor(path: string): LabelRule | undefined {
  const normalized = normalizeConfigPath(path);
  return LABEL_RULES.find((rule) => patternMatches(rule.pattern, normalized));
}

export function labelOf(path: string): ConfigLabel {
  const rule = ruleFor(path);
  if (!rule) throw new Error(`config path has no fixed/suggested label: ${path}`);
  return rule.label;
}

export interface ConfigChange {
  path: string;
  label: ConfigLabel;
  /** `undefined` when the leaf did not exist on that side (e.g. a level was added). */
  before: unknown;
  after: unknown;
}

/** Leaf-by-leaf difference between two config documents, labelled for approval. */
export function diffConfig(before: GameConfig, after: GameConfig): ConfigChange[] {
  const a = new Map(configLeaves(before).map((l) => [l.path, l.value]));
  const b = new Map(configLeaves(after).map((l) => [l.path, l.value]));
  const paths = [...new Set([...a.keys(), ...b.keys()])];
  return paths
    .filter((path) => !Object.is(a.get(path), b.get(path)))
    .map((path) => ({ path, label: labelOf(path), before: a.get(path), after: b.get(path) }));
}

/** True when a change touches an owner rule; the panel must then require the owner role. */
export function requiresOwnerApproval(changes: readonly ConfigChange[]): boolean {
  return changes.some((c) => c.label === 'fixed');
}
