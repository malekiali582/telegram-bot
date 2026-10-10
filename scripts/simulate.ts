/**
 * Economy simulation (spec §20):
 *
 *   npm run simulate                      # seed 42, 90 days, group of 20, report to stdout
 *   npm run simulate -- --seed 7 --out docs/simulation-report.md
 *
 * Reproducible: the same seed gives the same report. Uses the code defaults
 * (DEFAULT_GAME_CONFIG); see scripts/simulate/model.ts for what is modelled.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_GAME_CONFIG, TOOL_KINDS } from '@lulu/config';
import { TOOL_NAMES, levelName } from '@lulu/i18n';
import type { PlayerDay, ProfileId, SimResult, Source } from './simulate/model.ts';
import { PROFILES, SOURCES, groupMix, simulate } from './simulate/model.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '42' },
    days: { type: 'string', default: '90' },
    group: { type: 'string', default: '20' },
    out: { type: 'string' },
  },
});
const seed = Number(values.seed);
const days = Number(values.days);
const groupSize = Number(values.group);
const horizons = [7, 30, 90].filter((d) => d <= days);

const config = DEFAULT_GAME_CONFIG;
const main = simulate(config, { seed, days, mix: groupMix(groupSize) });

const SOURCE_NAMES: Record<Source, string> = {
  lolo: 'لولو',
  food: 'غذا',
  cemetery: 'قبرستان',
  interest: 'سود گنجینه',
  ghost: 'روح (شنیدم)',
  streak: 'استریک روزانه',
};
const PROFILE_IDS: ProfileId[] = ['low', 'normal', 'high'];

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}٪` : '—';
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function playersOf(r: SimResult, id: ProfileId) {
  return r.players.filter((p) => p.profile === id);
}
function at(r: SimResult, id: ProfileId, day: number): PlayerDay[] {
  return playersOf(r, id).map((p) => p.days[day - 1]!);
}
/** Median day a milestone was reached, and how many of the players reached it. */
function milestone(days: (number | null | undefined)[]) {
  const reached = days.filter((d): d is number => typeof d === 'number');
  const m = median(reached);
  if (m === null) return '—';
  return reached.length === days.length
    ? m.toFixed(1)
    : `${m.toFixed(1)} (${reached.length}/${days.length})`;
}

function supply(r: SimResult, day: number) {
  return r.players.reduce((acc, p) => acc + p.days[day - 1]!.cash + p.days[day - 1]!.treasury, 0);
}
function groupTotals(r: SimResult, day: number) {
  const earned = Object.fromEntries(SOURCES.map((k) => [k, 0])) as Record<Source, number>;
  let spent = 0;
  for (const p of r.players) {
    const d = p.days[day - 1]!;
    for (const k of SOURCES) earned[k] += d.earned[k];
    spent += sum(d.spent);
  }
  return { earned, spent };
}
/** Points minted and burned by the whole group on one day. */
function dayFlow(r: SimResult, day: number) {
  const now = groupTotals(r, day);
  const before =
    day > 1 ? groupTotals(r, day - 1) : { earned: groupTotals(r, day).earned, spent: 0 };
  const minted = Object.fromEntries(
    SOURCES.map((k) => [k, now.earned[k] - (day > 1 ? before.earned[k] : 0)]),
  ) as Record<Source, number>;
  return { minted, mintedTotal: sum(minted), burned: now.spent - before.spent };
}

const lines: string[] = [];
const out = (line = '') => lines.push(line);

out('# گزارش شبیه‌سازی اقتصاد «لولو»');
out();
out(
  `seed ${seed} · ${days} روز · یک گروه ${main.groupSize} نفره (${PROFILE_IDS.map((id) => `${playersOf(main, id).length} ${PROFILES[id].label}`).join('، ')}) · تنظیمات پیش‌فرض کد`,
);
out();
out('## الگوی بازیکن‌ها');
out();
out('| الگو | جلسه در روز | طول جلسه (دقیقه) | گنجینه |');
out('|---|---|---|---|');
for (const id of PROFILE_IDS) {
  const p = PROFILES[id];
  out(
    `| ${p.label} | ${p.sessionsPerDay} | ${p.sessionMinutes} | ${p.saves ? 'پس‌انداز در گنجینه' : 'استفاده نمی‌کند'} |`,
  );
}
out();
out(
  'در هر جلسه بازیکن هر کاری را که زمان انتظارش تمام شده انجام می‌دهد: لولو، شکار و جست‌وجوی روح. بهترین غذای سرداب را تا سقف ظرفیت می‌خورد و ارزان‌ترین هدف بعدی را، هر وقت پولش برسد، می‌خرد: سطح، ابزار بعدی یا قبرستان. روح پیداشده بلافاصله «شنیدم» می‌گیرد. آبادی، شکارگاه و نفرین‌ها سطح ۱ می‌مانند و اهدای خون مدل نشده است.',
);
out();

out('## زمان رسیدن به هر مرحله (میانهٔ روز)');
out();
out(`| مرحله | ${PROFILE_IDS.map((id) => PROFILES[id].label).join(' | ')} |`);
out(`|---|${PROFILE_IDS.map(() => '---').join('|')}|`);
out(
  `| افتتاح قبرستان | ${PROFILE_IDS.map((id) => milestone(playersOf(main, id).map((p) => p.cemeteryDay))).join(' | ')} |`,
);
for (let level = 2; level <= config.levels.length; level++) {
  out(
    `| سطح ${level} (${levelName(level)}) | ${PROFILE_IDS.map((id) => milestone(playersOf(main, id).map((p) => p.levelDay[level - 2] ?? null))).join(' | ')} |`,
  );
}
for (const tool of TOOL_KINDS) {
  out(
    `| ${TOOL_NAMES[tool]} | ${PROFILE_IDS.map((id) => milestone(playersOf(main, id).map((p) => p.toolDay[tool] ?? null))).join(' | ')} |`,
  );
}
out();
out(
  '«—» یعنی هیچ بازیکنی از این الگو تا پایان دوره به آن نرسید. عدد داخل پرانتز تعداد بازیکنانی است که رسیدند.',
);
out();

for (const day of horizons) {
  out(`## روز ${day}`);
  out();
  out(
    `| الگو | سطح (میانگین) | ابزار | دارایی (نقد + گنجینه) | ${SOURCES.map((k) => `سهم ${SOURCE_NAMES[k]}`).join(' | ')} | تولید | خرج |`,
  );
  out(`|---|---|---|---|${SOURCES.map(() => '---').join('|')}|---|---|`);
  for (const id of PROFILE_IDS) {
    const ds = at(main, id, day);
    const earned = Object.fromEntries(
      SOURCES.map((k) => [k, avg(ds.map((d) => d.earned[k]))]),
    ) as Record<Source, number>;
    const total = sum(earned);
    const spent = avg(ds.map((d) => sum(d.spent)));
    out(
      `| ${PROFILES[id].label} | ${avg(ds.map((d) => d.level)).toFixed(1)} | ${avg(ds.map((d) => d.tools)).toFixed(1)} | ${fmt(avg(ds.map((d) => d.cash + d.treasury)))} | ${SOURCES.map((k) => pct(earned[k], total)).join(' | ')} | ${fmt(total)} | ${fmt(spent)} |`,
    );
  }
  out();
}

out('## پول کل گروه');
out();
out(
  '| روز | پول در گردش (نقد + گنجینه) | تولید همان روز | خرج همان روز | تولید ÷ خرج | رشد پول در گردش |',
);
out('|---|---|---|---|---|---|');
for (const day of [...new Set([1, ...horizons, days])].sort((a, b) => a - b)) {
  const f = dayFlow(main, day);
  const prev = day > 1 ? supply(main, day - 1) : 0;
  const growth = prev > 0 ? `${(((supply(main, day) - prev) / prev) * 100).toFixed(1)}٪` : '—';
  out(
    `| ${day} | ${fmt(supply(main, day))} | ${fmt(f.mintedTotal)} | ${fmt(f.burned)} | ${f.burned > 0 ? (f.mintedTotal / f.burned).toFixed(1) : '∞'} | ${growth} |`,
  );
}
out();
const last = dayFlow(main, days);
out(
  `ترکیب تولید روز ${days}: ${SOURCES.map((k) => `${SOURCE_NAMES[k]} ${pct(last.minted[k], last.mintedTotal)}`).join('، ')}.`,
);
out();
const heard = avg(main.ghostsHeardPerDay);
out(
  `روح «شنیده‌شده» در گروه: میانگین ${heard.toFixed(1)} در روز، یعنی برای هر عضو حدود ${fmt(heard * config.ghosts.rewardPerMember)} پوینت در روز.`,
);
out();
const all = groupTotals(main, days);
out(
  `سهم هر منبع از کل درآمد ${days} روزهٔ گروه: ${SOURCES.map((k) => `${SOURCE_NAMES[k]} ${pct(all.earned[k], sum(all.earned))}`).join('، ')}.`,
);
out();

out('## حساسیت به اندازهٔ گروه');
out();
out(
  'پاداش روح و پاداش گروهی استریک به ازای هر عضو با اندازهٔ گروه بزرگ می‌شوند (روح به همهٔ اعضا ۵۰ می‌دهد؛ پاداش گروهی ۱۰۰ × min(اعضای فعال، ۲۰)). همان seed برای چند اندازه:',
);
out();
out(
  `| اندازهٔ گروه | پاداش روح هر عضو در روز | معمولی: سطح ۴ | معمولی: سطح ۵ | معمولی: کمان | تولید ${days} روزهٔ هر عضو | سهم روح در آن | سهم استریک در آن |`,
);
out('|---|---|---|---|---|---|---|---|');
for (const size of [5, 20, 50]) {
  const r = size === groupSize ? main : simulate(config, { seed, days, mix: groupMix(size) });
  const normal = playersOf(r, 'normal');
  const totals = groupTotals(r, days);
  const produced = sum(totals.earned) / r.players.length;
  out(
    `| ${size} | ${fmt(avg(r.ghostsHeardPerDay) * config.ghosts.rewardPerMember)} | ${milestone(normal.map((p) => p.levelDay[2] ?? null))} | ${milestone(normal.map((p) => p.levelDay[3] ?? null))} | ${milestone(normal.map((p) => p.toolDay.bow ?? null))} | ${fmt(produced)} | ${pct(totals.earned.ghost, sum(totals.earned))} | ${pct(totals.earned.streak, sum(totals.earned))} |`,
  );
}
out();

const report = lines.join('\n') + '\n';
if (values.out) {
  writeFileSync(values.out, report);
  process.stdout.write(`report written to ${values.out}\n`);
} else {
  process.stdout.write(report);
}
