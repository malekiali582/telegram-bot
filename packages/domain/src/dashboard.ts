import { BP_SCALE, CENTI_PER_POINT } from '@lulu/config';
import { queryRows } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { addDays, tehranDate, tehranMidnight } from './tehran.ts';

/**
 * Economy overview for the admin dashboard. Read-only; every figure comes from wallet
 * balances and ledger entries.
 *
 * - Money in circulation = player cash + treasuries + group blood banks.
 * - Produced = points created by a `mint:*` account; consumed = points destroyed by a
 *   `burn:*` account; admin corrections (`adjust:admin`) are reported separately.
 * - A day is a Tehran calendar day of the transactions' effective time.
 * - Active player = at least one successful «لولو» in the period (the same rule as the
 *   daily streak).
 */

export interface CirculationPoint {
  /** End of this Tehran day (for today: now). */
  date: string;
  cash: bigint;
  treasury: bigint;
  bloodBank: bigint;
  total: bigint;
}

export interface SourceAmount {
  /** System account code, e.g. `mint:lolo` or `burn:tool`. */
  code: string;
  centi: bigint;
}

export interface FlowSummary {
  produced: SourceAmount[];
  consumed: SourceAmount[];
  /** Net points given (+) or taken (−) by admin corrections. */
  adjustments: bigint;
  /** Change of money in circulation: produced − consumed + adjustments. */
  net: bigint;
}

export interface GrowthMeasure {
  /** First and last day-ends compared. */
  from: string;
  to: string;
  baseCenti: bigint;
  changeCenti: bigint;
  /** null when the base is below `monitoring.inflationMinCirculation`. */
  growthBp: number | null;
  thresholdBp: number;
  exceeded: boolean;
}

export interface EconomyOverview {
  today: string;
  players: {
    total: number;
    banned: number;
    activeToday: number;
    active7d: number;
    active30d: number;
  };
  groups: { total: number; withBot: number; activeToday: number };
  circulation: { now: CirculationPoint; daily: CirculationPoint[] };
  flows: { today: FlowSummary; week: FlowSummary; month: FlowSummary };
  inflation: {
    status: 'ok' | 'warning' | 'not_enough_data';
    /** The last full Tehran day. */
    day: GrowthMeasure;
    /** The last 7 full Tehran days. */
    week: GrowthMeasure;
    minCirculationCenti: bigint;
  };
}

const KIND_FIELD = {
  user_cash: 'cash',
  user_treasury: 'treasury',
  group_blood_bank: 'bloodBank',
} as const;
type Kind = keyof typeof KIND_FIELD;

const point = (date: string, parts: Record<'cash' | 'treasury' | 'bloodBank', bigint>) => ({
  date,
  ...parts,
  total: parts.cash + parts.treasury + parts.bloodBank,
});

function growth(
  series: Map<string, CirculationPoint>,
  from: string,
  to: string,
  thresholdBp: number,
  minCenti: bigint,
): GrowthMeasure {
  const base = series.get(from)?.total ?? 0n;
  const end = series.get(to)?.total ?? 0n;
  const change = end - base;
  const judged = base > 0n && base >= minCenti;
  const growthBp = judged ? Number((change * BigInt(BP_SCALE)) / base) : null;
  return {
    from,
    to,
    baseCenti: base,
    changeCenti: change,
    growthBp,
    thresholdBp,
    exceeded: growthBp !== null && growthBp >= thresholdBp,
  };
}

function flowSummary(rows: { code: string; amount: bigint }[]): FlowSummary {
  const produced: SourceAmount[] = [];
  const consumed: SourceAmount[] = [];
  let adjustments = 0n;
  for (const { code, amount } of rows) {
    if (amount === 0n) continue;
    // A mint account goes negative as it issues points; a burn account fills up.
    if (code.startsWith('mint:')) produced.push({ code, centi: -amount });
    else if (code.startsWith('burn:')) consumed.push({ code, centi: amount });
    else adjustments += -amount;
  }
  const byAmount = (a: SourceAmount, b: SourceAmount) =>
    b.centi > a.centi ? 1 : b.centi < a.centi ? -1 : a.code.localeCompare(b.code);
  produced.sort(byAmount);
  consumed.sort(byAmount);
  const sum = (xs: SourceAmount[]) => xs.reduce((s, x) => s + x.centi, 0n);
  return { produced, consumed, adjustments, net: sum(produced) - sum(consumed) + adjustments };
}

export async function economyOverview(ctx: DomainContext): Promise<EconomyOverview> {
  const now = ctx.clock.now();
  const db = ctx.db;
  const { config } = await ctx.config.effectiveAt(db, now);
  const today = tehranDate(now);
  const todayStart = tehranMidnight(today).toISOString();
  const weekStart = tehranMidnight(addDays(today, -6)).toISOString();
  const monthStart = tehranMidnight(addDays(today, -29)).toISOString();

  // ── money in circulation now, and per day back from it ──
  const balances = await queryRows<{ kind: Kind; total: string }>(
    db,
    sql`SELECT kind, coalesce(sum(balance), 0)::text AS total FROM wallets
        WHERE kind <> 'system' GROUP BY kind`,
  );
  const current = { cash: 0n, treasury: 0n, bloodBank: 0n };
  for (const b of balances) current[KIND_FIELD[b.kind]] = BigInt(b.total);

  const deltas = await queryRows<{ day: string; kind: Kind; delta: string }>(
    db,
    sql`SELECT to_char((t.effective_at AT TIME ZONE 'Asia/Tehran')::date, 'YYYY-MM-DD') AS day,
               w.kind, sum(le.amount)::text AS delta
        FROM ledger_entries le
        JOIN transactions t ON t.id = le.transaction_id
        JOIN wallets w ON w.id = le.wallet_id
        WHERE w.kind <> 'system' AND t.effective_at >= ${monthStart}::timestamptz
        GROUP BY 1, 2`,
  );
  const deltaOf = new Map<string, { cash: bigint; treasury: bigint; bloodBank: bigint }>();
  for (const d of deltas) {
    const entry = deltaOf.get(d.day) ?? { cash: 0n, treasury: 0n, bloodBank: 0n };
    entry[KIND_FIELD[d.kind]] += BigInt(d.delta);
    deltaOf.set(d.day, entry);
  }
  // Walk back from today: the end of day D = the end of day D+1 minus D+1's changes.
  const daily: CirculationPoint[] = [point(today, current)];
  let running = { ...current };
  for (let back = 1; back <= 30; back++) {
    const later = deltaOf.get(addDays(today, -back + 1));
    if (later) {
      running = {
        cash: running.cash - later.cash,
        treasury: running.treasury - later.treasury,
        bloodBank: running.bloodBank - later.bloodBank,
      };
    }
    daily.unshift(point(addDays(today, -back), running));
  }
  const byDate = new Map(daily.map((p) => [p.date, p]));

  // ── production and consumption by source ──
  const flows = await queryRows<{
    code: string;
    today: string | null;
    week: string | null;
    month: string;
  }>(
    db,
    sql`SELECT w.system_code AS code,
               (sum(le.amount) FILTER (WHERE t.effective_at >= ${todayStart}::timestamptz))::text AS today,
               (sum(le.amount) FILTER (WHERE t.effective_at >= ${weekStart}::timestamptz))::text AS week,
               sum(le.amount)::text AS month
        FROM ledger_entries le
        JOIN transactions t ON t.id = le.transaction_id
        JOIN wallets w ON w.id = le.wallet_id
        WHERE w.kind = 'system' AND t.effective_at >= ${monthStart}::timestamptz
        GROUP BY 1`,
  );
  const window = (key: 'today' | 'week' | 'month') =>
    flowSummary(flows.map((f) => ({ code: f.code, amount: BigInt(f[key] ?? '0') })));

  // ── players and groups ──
  const [activity] = await queryRows<Record<string, number>>(
    db,
    sql`SELECT count(DISTINCT user_id) FILTER (WHERE effective_at >= ${todayStart}::timestamptz)::int AS active_today,
               count(DISTINCT user_id) FILTER (WHERE effective_at >= ${weekStart}::timestamptz)::int AS active_7d,
               count(DISTINCT user_id)::int AS active_30d,
               count(DISTINCT group_id) FILTER (WHERE effective_at >= ${todayStart}::timestamptz)::int AS groups_today
        FROM transactions
        WHERE kind = 'lolo_reward' AND effective_at >= ${monthStart}::timestamptz`,
  );
  const [counts] = await queryRows<Record<string, number>>(
    db,
    sql`SELECT (SELECT count(*)::int FROM users WHERE NOT is_bot) AS players,
               (SELECT count(*)::int FROM users WHERE NOT is_bot AND banned_at IS NOT NULL) AS banned,
               (SELECT count(*)::int FROM groups) AS groups,
               (SELECT count(*)::int FROM groups WHERE bot_status = 'member') AS with_bot`,
  );

  // ── inflation: the last full day and the last 7 full days ──
  const minCenti = BigInt(config.monitoring.inflationMinCirculation) * BigInt(CENTI_PER_POINT);
  const yesterday = addDays(today, -1);
  const day = growth(
    byDate,
    addDays(today, -2),
    yesterday,
    config.monitoring.inflationDailyWarnBp,
    minCenti,
  );
  const week = growth(
    byDate,
    addDays(today, -8),
    yesterday,
    config.monitoring.inflationWeeklyWarnBp,
    minCenti,
  );
  const status =
    day.exceeded || week.exceeded
      ? 'warning'
      : day.growthBp === null && week.growthBp === null
        ? 'not_enough_data'
        : 'ok';

  return {
    today,
    players: {
      total: counts?.players ?? 0,
      banned: counts?.banned ?? 0,
      activeToday: activity?.active_today ?? 0,
      active7d: activity?.active_7d ?? 0,
      active30d: activity?.active_30d ?? 0,
    },
    groups: {
      total: counts?.groups ?? 0,
      withBot: counts?.with_bot ?? 0,
      activeToday: activity?.groups_today ?? 0,
    },
    circulation: { now: daily[daily.length - 1]!, daily },
    flows: { today: window('today'), week: window('week'), month: window('month') },
    inflation: { status, day, week, minCirculationCenti: minCenti },
  };
}
