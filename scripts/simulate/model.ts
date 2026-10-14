/**
 * Economy model for `npm run simulate` (spec §20). Pure and seeded: the same seed and
 * options always give the same result. It replays the game rules minute by minute for
 * one group of players, using the same configuration and the same rule functions as the
 * game (prey table, ghost chance, strongest tool, cemetery rate), and records where
 * every point came from and where it went.
 *
 * Simplifications (stated in the report):
 * - one group (so the streak reward always comes from it); city, hunting ground and
 *   curses stay at level 1; no blood-bank donations;
 * - players play in fixed daily sessions; during a session they do everything that is
 *   off cooldown, eat the best food they have, buy the cheapest next goal they can
 *   afford, and answer «شنیدم» at once;
 * - savers move all cash into the treasury at the end of every session and withdraw
 *   only to buy something.
 */
import { BP_SCALE, FOOD_KINDS, TOOL_KINDS } from '@lulu/config';
import type { FoodKind, GameConfig, ToolKind } from '@lulu/config';
import type { Rng } from '@lulu/domain';
import {
  ghostChance,
  groupStreakReward,
  personalStreakReward,
  pickPrey,
  strongestTool,
} from '@lulu/domain';

/** mulberry32: small, fast and good enough for a reproducible simulation. */
export class SeededRng implements Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

export type ProfileId = 'low' | 'normal' | 'high';

export interface Profile {
  id: ProfileId;
  label: string;
  sessionsPerDay: number;
  sessionMinutes: number;
  /** Keeps spare cash in the treasury (3 % a night). */
  saves: boolean;
}

export const PROFILES: Record<ProfileId, Profile> = {
  low: { id: 'low', label: 'کم‌فعال', sessionsPerDay: 2, sessionMinutes: 20, saves: false },
  normal: { id: 'normal', label: 'معمولی', sessionsPerDay: 4, sessionMinutes: 40, saves: true },
  high: { id: 'high', label: 'پرفعال', sessionsPerDay: 8, sessionMinutes: 60, saves: true },
};

export type Source = 'lolo' | 'food' | 'cemetery' | 'interest' | 'ghost' | 'streak';
export type Sink = 'level' | 'tool' | 'cemetery';
export const SOURCES: readonly Source[] = [
  'lolo',
  'food',
  'cemetery',
  'interest',
  'ghost',
  'streak',
];
export const SINKS: readonly Sink[] = ['level', 'tool', 'cemetery'];

/** A snapshot of one player at the end of a day (amounts in whole points). */
export interface PlayerDay {
  level: number;
  tools: number;
  cash: number;
  treasury: number;
  earned: Record<Source, number>;
  spent: Record<Sink, number>;
}

export interface SimPlayer {
  profile: ProfileId;
  /** Day (1-based, fractional) each level 2…6 was reached; null if not reached. */
  levelDay: (number | null)[];
  toolDay: Partial<Record<ToolKind, number>>;
  cemeteryDay: number | null;
  days: PlayerDay[];
}

export interface SimResult {
  seed: number;
  days: number;
  groupSize: number;
  players: SimPlayer[];
  ghostsHeardPerDay: number[];
}

interface MealState {
  startedMinute: number;
  paid: number;
  perDeposit: number;
}

interface State {
  profile: Profile;
  sessions: { start: number; end: number }[];
  level: number;
  tools: ToolKind[];
  cellar: Record<FoodKind, number>;
  meals: MealState[];
  cemetery: number | null;
  cemeteryRemainder: number;
  /** Centi-points. */
  cash: number;
  treasury: number;
  loloReadyAt: number;
  huntReadyAt: number;
  ghostReadyAt: number;
  ghostAttempts: number;
  ghostFound: number;
  ghostFailures: number;
  /** Streak in the group, the last day with a lolo, and the day of the first lolo. */
  streak: number;
  lastLoloDay: number;
  firstLoloDay: number | null;
  earned: Record<Source, number>;
  spent: Record<Sink, number>;
  extraBought: Set<string>;
  record: SimPlayer;
}

const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const DAY = 1_440;

/** Daily sessions: evenly spread over Tehran 08:00–24:00, each shifted a little at random. */
function dailySessions(p: Profile, rng: SeededRng): { start: number; end: number }[] {
  const open = 8 * 60;
  const span = 16 * 60;
  const slot = span / p.sessionsPerDay;
  return Array.from({ length: p.sessionsPerDay }, (_, i) => {
    const room = Math.max(0, slot - p.sessionMinutes);
    const start = Math.floor(open + i * slot + rng.next() * room);
    return { start, end: start + p.sessionMinutes };
  });
}

export interface SimOptions {
  seed: number;
  days: number;
  mix: ProfileId[];
  /**
   * What-if only: nightly interest in centi for a treasury balance in centi, instead of
   * `treasury.dailyInterestBp` (e.g. a cap or tiers the game does not have).
   */
  interestCenti?: (treasuryCenti: number) => number;
  /**
   * What-if only: extra things to buy once each, with a price and no effect, to measure
   * how much spending a new sink would absorb. Bought like any other goal (cheapest
   * first) and booked as tool spending.
   */
  extraGoals?: { id: string; cost: number }[];
}

export function simulate(config: GameConfig, options: SimOptions): SimResult {
  const rng = new SeededRng(options.seed);
  const c = config;
  const states: State[] = options.mix.map((id) => {
    const profile = PROFILES[id];
    return {
      profile,
      sessions: dailySessions(profile, rng),
      level: 1,
      tools: [],
      cellar: zero(FOOD_KINDS),
      meals: [],
      cemetery: null,
      cemeteryRemainder: 0,
      cash: 0,
      treasury: 0,
      loloReadyAt: 0,
      huntReadyAt: 0,
      ghostReadyAt: 0,
      ghostAttempts: 0,
      ghostFound: 0,
      ghostFailures: 0,
      streak: 0,
      lastLoloDay: -1,
      firstLoloDay: null,
      earned: zero(SOURCES),
      spent: zero(SINKS),
      extraBought: new Set<string>(),
      record: { profile: id, levelDay: [], toolDay: {}, cemeteryDay: null, days: [] },
    };
  });
  const ghostsHeardPerDay: number[] = [];
  const credit = (s: State, source: Source, centi: number) => {
    s.cash += centi;
    s.earned[source] += centi;
  };
  const dayOf = (minute: number) => Math.round((minute / DAY + 1) * 100) / 100;

  /** Pays `cost` points from cash, withdrawing from the treasury if needed. */
  const pay = (s: State, sink: Sink, costPoints: number): boolean => {
    const cost = costPoints * 100;
    if (s.cash + s.treasury < cost) return false;
    if (s.cash < cost) {
      s.treasury -= cost - s.cash;
      s.cash = cost;
    }
    s.cash -= cost;
    s.spent[sink] += cost;
    return true;
  };

  /** The cheapest next goal: level, the next tool in the list, or the cemetery. */
  const shop = (s: State, minute: number) => {
    for (;;) {
      const goals: { cost: number; sink: Sink; buy: () => void }[] = [];
      const levelCost = c.levels[s.level - 1]?.upgradeCost ?? null;
      if (levelCost !== null) {
        goals.push({
          cost: levelCost,
          sink: 'level',
          buy: () => {
            s.level++;
            s.record.levelDay[s.level - 2] = dayOf(minute);
          },
        });
      }
      const nextTool = TOOL_KINDS.find((t) => !s.tools.includes(t));
      if (nextTool) {
        goals.push({
          cost: c.tools[nextTool].price,
          sink: 'tool',
          buy: () => {
            s.tools.push(nextTool);
            s.record.toolDay[nextTool] = dayOf(minute);
          },
        });
      }
      if (s.cemetery === null) {
        goals.push({
          cost: c.cemetery.openCost,
          sink: 'cemetery',
          buy: () => {
            s.cemetery = 0;
            s.record.cemeteryDay = dayOf(minute);
          },
        });
      } else if (s.cemetery < c.cemetery.maxLevel) {
        goals.push({
          cost: c.cemetery.upgradeCosts[s.cemetery]!,
          sink: 'cemetery',
          buy: () => s.cemetery!++,
        });
      }
      for (const extra of options.extraGoals ?? []) {
        if (s.extraBought.has(extra.id)) continue;
        goals.push({ cost: extra.cost, sink: 'tool', buy: () => s.extraBought.add(extra.id) });
      }
      goals.sort((a, b) => a.cost - b.cost);
      const goal = goals[0];
      if (!goal) return;
      if (!pay(s, goal.sink, goal.cost)) return;
      goal.buy();
    }
  };

  for (let minute = 0; minute < options.days * DAY; minute++) {
    const tod = minute % DAY;
    if (tod === 0 && minute > 0) {
      // Tehran midnight: the streak reward of the day that just ended, one group only.
      const day = minute / DAY - 1;
      const loloed = states.filter((s) => s.lastLoloDay === day);
      const active = loloed.filter(
        (s) => s.firstLoloDay !== null && s.firstLoloDay <= day - c.streak.minAccountAgeDays,
      ).length;
      for (const s of loloed) {
        const points = personalStreakReward(c, s.streak) + groupStreakReward(c, active);
        credit(s, 'streak', points * 100);
      }
    }
    if (tod === 0) {
      ghostsHeardPerDay.push(0);
      for (const s of states) {
        // Tehran midnight: 3 % of the treasury, then the daily ghost counters reset.
        const interest = options.interestCenti
          ? options.interestCenti(s.treasury)
          : Math.floor((s.treasury * c.treasury.dailyInterestBp) / BP_SCALE);
        s.treasury += interest;
        s.earned.interest += interest;
        s.ghostAttempts = 0;
        s.ghostFound = 0;
        s.ghostFailures = 0;
      }
    }

    for (const s of states) {
      // Offline income: cemetery and food deposits.
      if (s.cemetery !== null) {
        const perMinute =
          (c.cemetery.baseHourlyIncome * 100 * (BP_SCALE + c.cemetery.levelBonusBp * s.cemetery)) /
          BP_SCALE /
          60;
        s.cemeteryRemainder += perMinute;
        const whole = Math.floor(s.cemeteryRemainder);
        s.cemeteryRemainder -= whole;
        credit(s, 'cemetery', whole);
      }
      const interval = c.food.depositIntervalSeconds / 60;
      const total = c.food.mealDurationSeconds / c.food.depositIntervalSeconds;
      for (const meal of s.meals) {
        if (meal.paid < total && minute - meal.startedMinute >= (meal.paid + 1) * interval) {
          meal.paid++;
          credit(s, 'food', meal.perDeposit * 100);
        }
      }
      s.meals = s.meals.filter((m) => m.paid < total);
    }

    for (const s of states) {
      const session = s.sessions.find((x) => tod >= x.start && tod < x.end);
      if (!session) continue;
      const level = c.levels[s.level - 1]!;

      if (minute >= s.loloReadyAt) {
        credit(s, 'lolo', rng.int(level.rewardMin, level.rewardMax) * 100);
        s.loloReadyAt = minute + c.lolo.cooldownSeconds / 60;
        const day = Math.floor(minute / DAY);
        if (s.lastLoloDay !== day) {
          s.streak = s.lastLoloDay === day - 1 ? s.streak + 1 : 1;
          s.lastLoloDay = day;
          s.firstLoloDay ??= day;
        }
      }

      const tool = strongestTool(c, s.tools);
      if (minute >= s.huntReadyAt && s.level >= c.hunt.minLevel && tool) {
        s.huntReadyAt = minute + c.hunt.cooldownSeconds / 60;
        if (rng.int(0, BP_SCALE - 1) < c.tools[tool].successBp) {
          const prey = pickPrey(
            c,
            { playerLevel: s.level, equippedTool: tool, huntingGroundLevel: 1 },
            rng,
          );
          s.cellar[prey]++;
        }
      }

      if (
        minute >= s.ghostReadyAt &&
        s.ghostAttempts < c.ghosts.dailyAttempts &&
        s.ghostFound < c.ghosts.dailyLimit
      ) {
        s.ghostReadyAt = minute + c.ghosts.cooldownSeconds / 60;
        s.ghostAttempts++;
        const chance = ghostChance(c, 1, s.ghostFailures);
        const found =
          BigInt(rng.int(0, BP_SCALE - 1)) * chance.denominator <
          chance.numerator * BigInt(BP_SCALE);
        if (found) {
          s.ghostFound++;
          s.ghostFailures = 0;
          // «شنیدم» at once: every member played within the last 7 days.
          ghostsHeardPerDay[ghostsHeardPerDay.length - 1]!++;
          for (const member of states) credit(member, 'ghost', c.ghosts.rewardPerMember * 100);
        } else {
          s.ghostFailures++;
        }
      }

      // Eat the best food first, up to the meal capacity.
      const free = level.mealCapacity - s.meals.length;
      const byValue = [...FOOD_KINDS].sort(
        (a, b) => c.foods[b].pointsPerDeposit - c.foods[a].pointsPerDeposit,
      );
      for (let i = 0; i < free; i++) {
        const food = byValue.find((f) => s.cellar[f] > 0);
        if (!food) break;
        s.cellar[food]--;
        s.meals.push({
          startedMinute: minute,
          paid: 0,
          perDeposit: c.foods[food].pointsPerDeposit,
        });
      }

      shop(s, minute);
      if (s.profile.saves && tod === session.end - 1) {
        s.treasury += s.cash;
        s.cash = 0;
      }
    }

    if (tod === DAY - 1) {
      for (const s of states) {
        s.record.days.push({
          level: s.level,
          tools: s.tools.length,
          cash: s.cash / 100,
          treasury: s.treasury / 100,
          earned: Object.fromEntries(SOURCES.map((k) => [k, s.earned[k] / 100])) as Record<
            Source,
            number
          >,
          spent: Object.fromEntries(SINKS.map((k) => [k, s.spent[k] / 100])) as Record<
            Sink,
            number
          >,
        });
      }
    }
  }

  return {
    seed: options.seed,
    days: options.days,
    groupSize: states.length,
    players: states.map((s) => s.record),
    ghostsHeardPerDay,
  };
}

/** A group of `size` players: 30 % low, 50 % normal, 20 % high activity (at least one each). */
export function groupMix(size: number): ProfileId[] {
  const high = Math.max(1, Math.round(size * 0.2));
  const low = Math.max(1, Math.round(size * 0.3));
  const normal = Math.max(1, size - high - low);
  return [
    ...Array<ProfileId>(low).fill('low'),
    ...Array<ProfileId>(normal).fill('normal'),
    ...Array<ProfileId>(high).fill('high'),
  ];
}
