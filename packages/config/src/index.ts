export * from './ids.ts';
export * from './schema.ts';
export * from './defaults.ts';
export * from './labels.ts';
export * from './env.ts';

import { gameConfigSchema } from './schema.ts';
import type { GameConfig } from './schema.ts';

/** Validates an untrusted config document (panel input, stored version). */
export function parseGameConfig(input: unknown): GameConfig {
  return gameConfigSchema.parse(input);
}

export interface ConfigIssue {
  /** Dot path, e.g. `levels[2].upgradeCost`. */
  path: string;
  /** Persian, for the admin panel. */
  message: string;
}

const CUSTOM_MESSAGES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^expected level (\d+)$/, (m) => `شمارهٔ سطح باید ${m[1]} باشد.`],
  [/^rewardMin > rewardMax$/, () => 'کمینهٔ پاداش از بیشینه بزرگ‌تر است.'],
  [/null upgradeCost$/, () => 'فقط آخرین (یا اولین) سطح هزینهٔ ارتقا ندارد.'],
  [/^meal duration must be a multiple/, () => 'مدت وعده باید مضربی از فاصلهٔ واریزها باشد.'],
  [
    /^minLevel exceeds max player level (\d+)$/,
    (m) => `از بالاترین سطح بازیکن (${m[1]}) بیشتر است.`,
  ],
  [/^above max player level$/, () => 'از بالاترین سطح بازیکن بیشتر است.'],
  [
    /^weights sum to (\d+) bp, expected (\d+)$/,
    (m) => `جمع وزن‌ها ${m[1]} bp است؛ باید ${m[2]} باشد.`,
  ],
  [/^expected (\d+) upgrade costs$/, (m) => `باید ${m[1]} هزینهٔ ارتقا باشد.`],
  [/^exceeds defined hunting ground levels$/, () => 'از تعداد سطح‌های شکارگاه بیشتر است.'],
  [/^exceeds defined curse levels$/, () => 'از تعداد سطح‌های نفرین بیشتر است.'],
  [/^caps must not decrease/, () => 'سقف‌ها با بالا رفتن سطح بانک خون نباید کم شوند.'],
  [/^bank level can never exceed/, () => 'سطح بانک خون نمی‌تواند از سطح لولوآباد بیشتر شود.'],
  [/^max curse level would reduce/, () => 'بالاترین سطح نفرین زمان انتظار را به صفر می‌رساند.'],
  [/^above base chance$/, () => 'از شانس پایه بیشتر است.'],
  [/^chance exceeds 100%/, () => 'شانس در بالاترین سطح لولوآباد از ۱۰۰٪ بیشتر می‌شود.'],
  [
    /^more ghosts per day than search attempts$/,
    () => 'سقف روح روزانه از تعداد تلاش‌های روزانه بیشتر است.',
  ],
];

function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (acc, seg) =>
      typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg),
    '',
  );
}

/**
 * Validates a config document and explains every problem in Persian, by path. An empty
 * list means the document is valid.
 */
export function configIssues(input: unknown): ConfigIssue[] {
  const result = gameConfigSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issuePath(issue.path);
    let message: string;
    if (issue.code === 'too_small') message = `باید دست‌کم ${String(issue.minimum)} باشد.`;
    else if (issue.code === 'too_big') message = `باید حداکثر ${String(issue.maximum)} باشد.`;
    else if (issue.code === 'invalid_type') message = 'مقدار باید عدد صحیح باشد.';
    else if (issue.code === 'unrecognized_keys') message = 'کلید ناشناخته دارد.';
    else if (issue.code === 'invalid_value') message = 'این مقدار مجاز نیست.';
    else {
      const match = CUSTOM_MESSAGES.map(([re, text]) => {
        const m = re.exec(issue.message);
        return m ? text(m) : null;
      }).find((t) => t !== null);
      message = match ?? issue.message;
    }
    return { path, message };
  });
}
