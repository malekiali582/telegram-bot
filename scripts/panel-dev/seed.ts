/**
 * Labelled sample data for the admin panel's development mode (`npm run dev:panel`).
 *
 * Players and groups are made by the real domain services over a simulated clock, so
 * every number in the panel comes from genuine ledger rows: «لولو» claims, hunts, meals,
 * level and tool purchases, treasury deposits and interest, cemeteries, blood
 * donations, ghosts and daily streaks. Every player and group name starts with
 * «[نمونه]» and carries `is_sample`, and both platforms (Telegram, Rubika) appear.
 *
 * Refuses to run in production, or on a database that has any real player or group.
 */
import { readFileSync } from 'node:fs';
import { CENTI_PER_POINT, DEFAULT_GAME_CONFIG, TOOL_KINDS } from '@lulu/config';
import type { ToolKind } from '@lulu/config';
import type { Database, Platform } from '@lulu/database';
import { groups, jobRuns, jobState, outbox, queryRows, users } from '@lulu/database';
import type { Clock, DomainContext, Rng } from '@lulu/domain';
import {
  activateDueBatches,
  addDays,
  attachEncounterMessage,
  botRemovedFromGroup,
  buyTool,
  claimLolo,
  createDomainContext,
  depositToTreasury,
  donateBlood,
  eat,
  hearGhost,
  hunt,
  importGhostBatch,
  migrateGroupChat,
  noteGroupPresence,
  openCemetery,
  registerGroup,
  registerPlayer,
  searchGhost,
  settleDuePlayers,
  tehranDate,
  tehranMidnight,
  upgradeLevel,
  userWallets,
} from '@lulu/domain';
import { eq, sql } from 'drizzle-orm';

export const SAMPLE_PREFIX = '[نمونه] ';

export interface SeedOptions {
  players: number;
  groups: number;
  /** Whole Tehran days of history before today. */
  days: number;
  /** Real current instant; the history ends just before it. */
  now: Date;
  /** Same seed, same data. */
  seed?: number;
  onProgress?: (day: number, days: number) => void;
}

export const FULL_SAMPLE: Pick<SeedOptions, 'players' | 'groups' | 'days'> = {
  players: 60,
  groups: 8,
  days: 45,
};

export type SeedResult =
  | { status: 'seeded'; players: number; groups: number; transactions: number }
  | { status: 'already_seeded' };

export class SampleSeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleSeedRefused';
  }
}

// ───────────────────────── deterministic randomness and time ─────────────────────────

/** mulberry32: small, fast and reproducible; never used for real game randomness. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class SeedClock implements Clock {
  current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now(): Date {
    return this.current;
  }
}

// ───────────────────────── names ─────────────────────────

const FIRST = [
  'لولوی',
  'شبح',
  'جن',
  'سایهٔ',
  'کابوس',
  'خفاش',
  'گرگ',
  'جغد',
  'روح',
  'هیولای',
  'مترسک',
  'غول',
  'عنکبوت',
  'شیطانک',
  'دیو',
];
const SECOND = [
  'خواب‌آلود',
  'زیرزمین',
  'نیمه‌شب',
  'پشت‌بام',
  'بی‌قرار',
  'گرسنه',
  'کوچه',
  'مه‌آلود',
  'خندان',
  'قدیمی',
  'ساکت',
  'شیطون',
  'تنها',
  'سرگردان',
];
const CITY = [
  'محلهٔ مه‌آلود',
  'کوچهٔ بن‌بست',
  'قبرستان قدیمی',
  'برج متروک',
  'جنگل سیاه',
  'آسیاب خاموش',
  'دهکدهٔ نیمه‌شب',
  'سرداب ساکت',
  'باغ وحشت',
  'خانهٔ ته کوچه',
];

type Profile = 'high' | 'normal' | 'low';
const SLOT_CHANCE: Record<Profile, number> = { high: 0.85, normal: 0.45, low: 0.15 };
/** Tehran hours at which players show up. */
const SLOTS = [9, 12, 15, 18, 21, 23];

interface SamplePlayer {
  userId: number;
  platform: Platform;
  profile: Profile;
  joinDay: number;
  /** Stops playing after this day (churn), if set. */
  quitDay: number | null;
  groupIds: number[];
  level: number;
  tools: Set<ToolKind>;
}

interface SampleGroup {
  groupId: number;
  platform: Platform;
  chatId: string;
}

// ───────────────────────── guards ─────────────────────────

/** Written last by the seeder, so its presence means the sample data is complete. */
const SAMPLE_WORKER = 'sample-worker';

async function existing(
  db: Database,
): Promise<{ real: boolean; sample: boolean; complete: boolean }> {
  const [row] = await queryRows<{ real: boolean; sample: boolean; complete: boolean }>(
    db,
    sql`SELECT (EXISTS (SELECT 1 FROM users WHERE NOT is_sample)
                OR EXISTS (SELECT 1 FROM groups WHERE NOT is_sample)) AS real,
               (EXISTS (SELECT 1 FROM users WHERE is_sample)
                OR EXISTS (SELECT 1 FROM groups WHERE is_sample)) AS sample,
               EXISTS (SELECT 1 FROM job_runs WHERE lease_owner = ${SAMPLE_WORKER}) AS complete`,
  );
  return {
    real: Boolean(row?.real),
    sample: Boolean(row?.sample),
    complete: Boolean(row?.complete),
  };
}

// ───────────────────────── seeding ─────────────────────────

export async function seedSampleData(db: Database, options: SeedOptions): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new SampleSeedRefused('sample data is never loaded in production');
  }
  const state = await existing(db);
  if (state.real) {
    throw new SampleSeedRefused(
      'this database has real players or groups; sample data goes only into an empty development database',
    );
  }
  if (state.sample && state.complete) return { status: 'already_seeded' };
  if (state.sample) {
    throw new SampleSeedRefused(
      'the sample data from an earlier run is incomplete (it stopped part-way); delete the development database folder and start again',
    );
  }

  const random = seededRandom(options.seed ?? 20_261_012);
  const chance = (p: number) => random() < p;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const rng: Rng = { int: (min, max) => min + Math.floor(random() * (max - min + 1)) };

  const today = tehranDate(options.now);
  const firstDay = addDays(today, -options.days);
  const clock = new SeedClock(tehranMidnight(firstDay));
  // Rubika players and groups are identities only: no Rubika adapter exists yet, so the
  // context keeps the default platform list (it decides shared limits such as text length).
  const ctx: DomainContext = createDomainContext(db, { clock, rng });
  const at = (day: number, hour: number, minute = 0) =>
    new Date(tehranMidnight(addDays(firstDay, day)).getTime() + (hour * 60 + minute) * 60_000);
  const config = DEFAULT_GAME_CONFIG;

  // Ghost content: past, live and upcoming batches (and a gap after them, for the warning).
  clock.current = at(0, 0, 1);
  const ghostSample = JSON.parse(
    readFileSync(new URL('../../content/ghosts/example.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const ghostDays = [0, 8, 19, 31, options.days, options.days + 1, options.days + 2];
  for (const day of ghostDays) {
    const activeDate = addDays(firstDay, day);
    await importGhostBatch(
      ctx,
      { ...ghostSample, batchId: `sample-${activeDate}`, activeDate },
      { source: 'dev_seed', isSample: true },
    );
  }
  await activateDueBatches(ctx);

  // Groups: three quarters on Telegram, the rest on Rubika.
  const sampleGroups: SampleGroup[] = [];
  const rubikaGroups = Math.max(1, Math.round(options.groups / 4));
  for (let i = 0; i < options.groups; i++) {
    const platform: Platform = i < options.groups - rubikaGroups ? 'telegram' : 'rubika';
    const chatId =
      platform === 'telegram' ? `-1009${String(1000 + i).padStart(9, '0')}` : `g0sample${i}`;
    clock.current = at(Math.min(i, options.days - 1), 10, i);
    const { groupId } = await registerGroup(ctx, {
      platform,
      platformChatId: chatId,
      title: `${SAMPLE_PREFIX}${CITY[i % CITY.length]}${i >= CITY.length ? ` ${i + 1}` : ''}`,
    });
    await db.update(groups).set({ isSample: true }).where(eq(groups.id, groupId));
    sampleGroups.push({ groupId, platform, chatId });
  }
  const groupsOn = (platform: Platform) => sampleGroups.filter((g) => g.platform === platform);

  // Players join over the first two thirds of the period.
  const players: SamplePlayer[] = [];
  const rubikaPlayers = Math.max(1, Math.round(options.players / 4));
  for (let i = 0; i < options.players; i++) {
    const platform: Platform = i < options.players - rubikaPlayers ? 'telegram' : 'rubika';
    const roll = random();
    const profile: Profile = roll < 0.15 ? 'high' : roll < 0.65 ? 'normal' : 'low';
    const joinDay = Math.floor(random() * Math.max(1, Math.floor((options.days * 2) / 3)));
    const pool = groupsOn(platform);
    const home = pool[i % pool.length]!;
    const second = chance(0.3) ? pick(pool) : home;
    players.push({
      userId: 0,
      platform,
      profile,
      joinDay,
      quitDay: chance(0.12) ? joinDay + 3 + Math.floor(random() * 10) : null,
      groupIds: [...new Set([home.groupId, second.groupId])],
      level: 1,
      tools: new Set(),
    });
  }

  const countTransactions = async () =>
    Number(
      (await queryRows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM transactions`))[0]
        ?.n ?? 0,
    );
  const transactionsBefore = await countTransactions();

  const register = async (p: SamplePlayer, index: number) => {
    const name = `${pick(FIRST)} ${pick(SECOND)}`;
    const result = await registerPlayer(ctx, {
      platform: p.platform,
      platformUserId:
        p.platform === 'telegram' ? String(9_000_000_000 + index) : `u0sample${index}`,
      displayName: `${SAMPLE_PREFIX}${name}`,
      username: chance(0.7) ? `sample_lulu_${index}` : null,
    });
    if (result.status !== 'ok') throw new Error('sample player was rejected');
    p.userId = result.userId;
    await db.update(users).set({ isSample: true }).where(eq(users.id, p.userId));
    for (const groupId of p.groupIds) await noteGroupPresence(ctx, { groupId, userId: p.userId });
  };

  const cashOf = async (userId: number) => (await userWallets(db, userId)).cash.balance;
  const points = (centi: bigint) => centi / BigInt(CENTI_PER_POINT);

  /** One visit: a few «لولو»s and whatever else the player can afford. */
  const visit = async (p: SamplePlayer, start: Date) => {
    clock.current = start;
    const groupId = pick(p.groupIds);
    const group = sampleGroups.find((g) => g.groupId === groupId)!;
    const lolos = p.profile === 'high' ? 3 : p.profile === 'normal' ? 2 : 1;
    for (let i = 0; i < lolos; i++) {
      await claimLolo(ctx, { userId: p.userId, groupId: group.groupId });
      clock.current = new Date(clock.current.getTime() + (config.lolo.cooldownSeconds + 20) * 1000);
    }

    if (p.level >= config.hunt.minLevel && p.tools.size > 0 && chance(0.6)) {
      const result = await hunt(ctx, { userId: p.userId, groupId: group.groupId });
      if (result.status === 'success' && chance(0.8)) {
        await eat(ctx, { userId: p.userId, food: result.food, count: 1 });
      }
    }
    if (chance(0.12)) {
      const result = await searchGhost(ctx, {
        userId: p.userId,
        groupId: group.groupId,
        platform: group.platform,
        chatId: group.chatId,
      });
      if (result.status === 'found' && chance(0.85)) {
        const messageId = String(Math.floor(random() * 1e9));
        await attachEncounterMessage(ctx, { encounterId: result.encounterId, messageId });
        clock.current = new Date(clock.current.getTime() + 40_000);
        await hearGhost(ctx, {
          userId: p.userId,
          groupId: group.groupId,
          platform: group.platform,
          replyChatId: group.chatId,
          replyToMessageId: messageId,
          replyFromThisBot: true,
        });
      }
    }

    // Spending decisions look at the wallet like a player would.
    let cash = await cashOf(p.userId);
    const cost = config.levels[p.level - 1]?.upgradeCost;
    if (cost !== null && cost !== undefined && points(cash) >= cost && chance(0.7)) {
      const result = await upgradeLevel(ctx, { userId: p.userId, expectedLevel: p.level });
      if (result.status === 'ok') p.level += 1;
      cash = await cashOf(p.userId);
    }
    if (p.level >= config.hunt.minLevel) {
      const next = TOOL_KINDS.find((t) => !p.tools.has(t));
      if (next && points(cash) >= config.tools[next].price && chance(0.5)) {
        const result = await buyTool(ctx, { userId: p.userId, tool: next });
        if (result.status === 'ok') p.tools.add(next);
        cash = await cashOf(p.userId);
      }
    }
    if (cash > 0n && chance(0.1)) {
      await depositToTreasury(ctx, { userId: p.userId, amountCenti: cash / 2n });
    } else if (cash > 0n && chance(0.04)) {
      await donateBlood(ctx, { userId: p.userId, groupId: group.groupId, amountCenti: cash / 5n });
    } else if (chance(0.05)) {
      await openCemetery(ctx, { userId: p.userId });
    }
  };

  const settleAll = async () => {
    let afterUserId: number | undefined;
    for (;;) {
      const batch = await settleDuePlayers(ctx, {
        ...(afterUserId ? { afterUserId } : {}),
        limit: 200,
      });
      if (batch.settled < 200 || batch.lastUserId === undefined) break;
      afterUserId = batch.lastUserId;
    }
  };

  const migratedGroup = groupsOn('telegram')[1];
  const removedGroup = groupsOn('telegram')[2];

  for (let day = 0; day <= options.days; day++) {
    // Midnight: interest, cemeteries, streak rewards, the night's ghost batch.
    clock.current = at(day, 0, 5);
    await settleAll();
    await activateDueBatches(ctx);

    for (const [index, p] of players.entries()) {
      if (p.joinDay === day) {
        clock.current = at(day, 8, index % 60);
        await register(p, index);
      }
    }

    // A supergroup migration and a group that removed the bot, for the panel's views.
    if (migratedGroup && day === Math.floor(options.days * 0.6)) {
      clock.current = at(day, 7);
      const toChatId = `-1009${String(5000).padStart(9, '0')}`;
      await migrateGroupChat(ctx, {
        platform: 'telegram',
        fromChatId: migratedGroup.chatId,
        toChatId,
      });
      migratedGroup.chatId = toChatId;
    }
    if (removedGroup && day === Math.max(1, options.days - 4)) {
      clock.current = at(day, 7, 30);
      await botRemovedFromGroup(ctx, { platform: 'telegram', platformChatId: removedGroup.chatId });
      for (const p of players) p.groupIds = p.groupIds.filter((g) => g !== removedGroup.groupId);
      for (const p of players) {
        if (p.groupIds.length === 0) p.groupIds.push(groupsOn(p.platform)[0]!.groupId);
      }
    }

    for (const [slotIndex, hour] of SLOTS.entries()) {
      const slotStart = at(day, hour);
      if (slotStart >= options.now) break;
      for (const [index, p] of players.entries()) {
        if (p.userId === 0 || (p.quitDay !== null && day > p.quitDay)) continue;
        if (!chance(SLOT_CHANCE[p.profile])) continue;
        const start = new Date(slotStart.getTime() + ((index * 7 + slotIndex) % 50) * 60_000);
        if (start >= options.now) continue;
        await visit(p, start);
      }
    }
    options.onProgress?.(day + 1, options.days + 1);
  }

  // A migration conflict (the new chat id already belongs to a city with data) and a
  // group an admin disabled, for the groups pages. After the activity, so nothing that
  // happened earlier depends on them.
  const telegramGroups = groupsOn('telegram');
  const busy = telegramGroups[0];
  const conflicting = telegramGroups.at(-1);
  if (busy && conflicting && conflicting !== busy) {
    clock.current = new Date(options.now.getTime() - 3 * 3_600_000);
    await migrateGroupChat(ctx, {
      platform: 'telegram',
      fromChatId: conflicting.chatId,
      toChatId: busy.chatId,
    });
  }
  const disabled = groupsOn('rubika')[0];
  if (disabled) {
    await db
      .update(groups)
      .set({
        disabledAt: new Date(options.now.getTime() - 2 * 3_600_000),
        disabledReason: `${SAMPLE_PREFIX}تبلیغات مکرر در گروه`,
      })
      .where(eq(groups.id, disabled.groupId));
  }

  // One banned player (the reason is labelled too).
  const banned = players.find((p) => p.userId !== 0 && p.profile === 'low');
  if (banned) {
    await db
      .update(users)
      .set({ bannedAt: at(options.days - 2, 14), banReason: `${SAMPLE_PREFIX}تقلب با چند حساب` })
      .where(eq(users.id, banned.userId));
  }

  await seedSystemRows(db, options.now, sampleGroups);

  const transactions = (await countTransactions()) - transactionsBefore;
  return {
    status: 'seeded',
    players: players.filter((p) => p.userId !== 0).length,
    groups: sampleGroups.length,
    transactions,
  };
}

/** Outbox messages (one failed for good) and job history (one failed run). */
async function seedSystemRows(db: Database, now: Date, sampleGroups: SampleGroup[]) {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const chat = (i: number) => sampleGroups[i % sampleGroups.length]!;
  const message = (i: number, text: string) => ({
    platformChatId: chat(i).chatId,
    text: `${SAMPLE_PREFIX}${text}`,
    format: 'plain' as const,
  });

  await db.insert(outbox).values([
    {
      platform: chat(0).platform,
      kind: 'send',
      payload: message(0, 'لولو! ۴۲ لولوپوینت گرفتی.'),
      status: 'sent',
      attempts: 1,
      createdAt: ago(50),
      nextAttemptAt: ago(50),
      sentAt: ago(50),
    },
    {
      platform: chat(1).platform,
      kind: 'send',
      payload: message(1, 'روحی پیدا شد… هر کس پیدایش کرده «شنیدم» را جواب بدهد.'),
      status: 'sent',
      attempts: 2,
      createdAt: ago(35),
      nextAttemptAt: ago(34),
      sentAt: ago(34),
    },
    {
      platform: chat(2).platform,
      kind: 'send',
      payload: message(2, 'لولوآباد به سطح ۲ رسید!'),
      status: 'dead',
      attempts: 8,
      lastError: 'Forbidden: bot was kicked from the supergroup chat',
      createdAt: ago(240),
      nextAttemptAt: ago(200),
    },
    {
      platform: chat(3).platform,
      kind: 'send',
      payload: message(3, 'جایزهٔ استریک امروز پرداخت شد.'),
      status: 'pending',
      attempts: 1,
      lastError: 'Too Many Requests: retry after 7',
      createdAt: ago(1),
      nextAttemptAt: new Date(now.getTime() + 60 * 60_000),
    },
  ]);

  const runs: (typeof jobRuns.$inferInsert)[] = [];
  for (const [name, every, stats] of [
    ['settlement', 1, { settled: 12 }],
    ['ghost-activation', 0.5, { activated: null, retired: null, cancelled: 0 }],
    ['cleanup', 60, { processedUpdates: 0 }],
  ] as const) {
    for (let i = 5; i >= 1; i--) {
      runs.push({
        jobName: name,
        leaseOwner: SAMPLE_WORKER,
        startedAt: ago(i * every),
        finishedAt: ago(i * every - 0.01),
        status: 'succeeded',
        stats,
      });
    }
  }
  runs.push({
    jobName: 'settlement',
    leaseOwner: SAMPLE_WORKER,
    startedAt: ago(90),
    finishedAt: ago(89.9),
    status: 'failed',
    error: `${SAMPLE_PREFIX}Connection terminated unexpectedly`,
  });
  await db.insert(jobRuns).values(runs);
  await db
    .insert(jobState)
    .values([
      { name: 'settlement', nextRunAt: ago(-1), lastStartedAt: ago(1), lastFinishedAt: ago(0.99) },
      {
        name: 'ghost-activation',
        nextRunAt: ago(-0.5),
        lastStartedAt: ago(0.5),
        lastFinishedAt: ago(0.49),
      },
      {
        name: 'cleanup',
        nextRunAt: ago(-55),
        lastStartedAt: ago(5),
        lastFinishedAt: ago(4.99),
        lastError: `${SAMPLE_PREFIX}statement timeout`,
        consecutiveFailures: 1,
      },
    ])
    .onConflictDoNothing();
}

/** Players and groups the seeder made, for tests and the dev banner. */
export async function sampleCounts(db: Database) {
  const [row] = await queryRows<{ players: number; groups: number; platforms: string[] }>(
    db,
    sql`SELECT (SELECT count(*)::int FROM users WHERE is_sample) AS players,
               (SELECT count(*)::int FROM groups WHERE is_sample) AS groups,
               (SELECT array_agg(DISTINCT platform) FROM user_identities ui
                  JOIN users u ON u.id = ui.user_id WHERE u.is_sample) AS platforms`,
  );
  return row!;
}
