import { BP_SCALE } from '@lulu/config';
import type { GameConfig } from '@lulu/config';
import type { Platform } from '@lulu/database';
import {
  dailyGhostState,
  ghostBatches,
  ghostEncounters,
  ghostMessageRefs,
  ghostStories,
  inTransaction,
  playerState,
  settlements,
  users,
} from '@lulu/database';
import { and, eq, gt, isNull, notInArray, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { claimWaitNotice, cooldownAvailableAt, isCoolingDown, startCooldown } from './cooldowns.ts';
import { activateDueBatches } from './ghost-batches.ts';
import { postTransaction } from './ledger.ts';
import { beginPlayerAction, touchMembership } from './players.ts';
import { addDays, tehranDate, tehranMidnight } from './tehran.ts';

/** Exact chance as a fraction of 1. */
export interface Chance {
  numerator: bigint;
  denominator: bigint;
}

/**
 * max(floor, base(city) × 0.9^failures), exactly (spec §12). The base grows by the
 * per-level bonus with the city level; the multiplier and floor are owner rules.
 */
export function ghostChance(config: GameConfig, cityLevel: number, failures: number): Chance {
  const g = config.ghosts;
  const scale = BigInt(BP_SCALE);
  const base = BigInt(g.baseChanceBp + g.cityLevelBonusBp * (cityLevel - 1));
  const numerator = base * BigInt(g.failureMultiplierBp) ** BigInt(failures);
  const denominator = scale * scale ** BigInt(failures);
  const floor = BigInt(g.minChanceBp);
  return numerator * scale < floor * denominator
    ? { numerator: floor, denominator: scale }
    : { numerator, denominator };
}

/** A roll in [0, 10 000) succeeds when roll / 10 000 < chance. */
function rollSucceeds(roll: number, chance: Chance): boolean {
  return BigInt(roll) * chance.denominator < chance.numerator * BigInt(BP_SCALE);
}

export type GhostSearchResult =
  | {
      status: 'found';
      encounterId: number;
      text: string;
      fearReward: number;
      expiresAt: Date;
      foundToday: number;
      dailyLimit: number;
      nextAvailableAt: Date;
    }
  | { status: 'not_found'; consecutiveFailures: number; nextChance: Chance; nextAvailableAt: Date }
  | { status: 'daily_limit'; dailyLimit: number; resetsAt: Date }
  | { status: 'no_content' }
  | { status: 'cooldown'; availableAt: Date; remainingMs: number; notify: boolean }
  | { status: 'banned' };

/**
 * «جستجوی روح» in a group. At most `dailyLimit` (3) ghosts per player per Tehran day
 * across all groups; a found ghost uses the quota even before «شنیدم». Counters and
 * consecutive failures are per Tehran day, so they reset at midnight, while the
 * cooldown is an instant and survives midnight. Without live content nothing is
 * consumed. The fear reward is fixed when the ghost is found.
 */
export async function searchGhost(
  ctx: DomainContext,
  input: { userId: number; groupId: number; platform: Platform; chatId: string },
): Promise<GhostSearchResult> {
  await activateDueBatches(ctx);
  const now = ctx.clock.now();
  const today = tehranDate(now);

  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };

    const [daily] = await tx
      .select()
      .from(dailyGhostState)
      .where(and(eq(dailyGhostState.userId, input.userId), eq(dailyGhostState.tehranDate, today)));
    const foundToday = daily?.foundCount ?? 0;
    const failures = daily?.consecutiveFailures ?? 0;
    if (foundToday >= config.ghosts.dailyLimit) {
      return {
        status: 'daily_limit',
        dailyLimit: config.ghosts.dailyLimit,
        resetsAt: tehranMidnight(addDays(today, 1)),
      };
    }

    const availableAt = await cooldownAvailableAt(tx, input.userId, 'ghost');
    if (availableAt && isCoolingDown(availableAt, now)) {
      const notify = await claimWaitNotice(tx, {
        userId: input.userId,
        groupId: input.groupId,
        kind: 'ghost',
        now,
        throttleSeconds: config.lolo.waitNoticeThrottleSeconds,
      });
      return {
        status: 'cooldown',
        availableAt,
        remainingMs: availableAt.getTime() - now.getTime(),
        notify,
      };
    }

    // Stories of the live batch this player has not seen today.
    const seenToday = tx
      .select({ id: ghostEncounters.storyId })
      .from(ghostEncounters)
      .where(and(eq(ghostEncounters.userId, input.userId), eq(ghostEncounters.tehranDate, today)));
    const candidates = await tx
      .select({ id: ghostStories.id, text: ghostStories.text })
      .from(ghostStories)
      .innerJoin(ghostBatches, eq(ghostBatches.id, ghostStories.batchId))
      .where(and(eq(ghostBatches.status, 'active'), notInArray(ghostStories.id, seenToday)))
      .orderBy(ghostStories.position);
    if (candidates.length === 0) return { status: 'no_content' };

    const [city] = await tx
      .select({ level: settlements.level })
      .from(settlements)
      .where(eq(settlements.groupId, input.groupId));
    const chance = ghostChance(config, city?.level ?? 1, failures);
    const found = rollSucceeds(ctx.rng.int(0, BP_SCALE - 1), chance);

    // A valid attempt: start the cooldown (no group buff applies to ghosts).
    const nextAvailableAt = await startCooldown(tx, {
      userId: input.userId,
      kind: 'ghost',
      now,
      groupId: input.groupId,
      baseSeconds: config.ghosts.cooldownSeconds,
      effectiveSeconds: config.ghosts.cooldownSeconds,
    });
    await touchMembership(tx, input.groupId, input.userId, now, true);

    const newFound = found ? foundToday + 1 : foundToday;
    const newFailures = found ? 0 : failures + 1;
    await tx
      .insert(dailyGhostState)
      .values({
        userId: input.userId,
        tehranDate: today,
        foundCount: newFound,
        consecutiveFailures: newFailures,
      })
      .onConflictDoUpdate({
        target: [dailyGhostState.userId, dailyGhostState.tehranDate],
        set: { foundCount: newFound, consecutiveFailures: newFailures },
      });

    if (!found) {
      await postTransaction(tx, {
        kind: 'ghost_search',
        effectiveAt: now,
        userId: input.userId,
        groupId: input.groupId,
        configVersionId: versionId,
        entries: [],
        metadata: { found: false, consecutiveFailures: newFailures },
      });
      return {
        status: 'not_found',
        consecutiveFailures: newFailures,
        nextChance: ghostChance(config, city?.level ?? 1, newFailures),
        nextAvailableAt,
      };
    }

    const story = candidates[ctx.rng.int(0, candidates.length - 1)]!;
    const fearReward = ctx.rng.int(config.ghosts.fearMin, config.ghosts.fearMax);
    const expiresAt = new Date(now.getTime() + config.ghosts.replyDeadlineHours * 3_600_000);
    const [encounter] = await tx
      .insert(ghostEncounters)
      .values({
        userId: input.userId,
        groupId: input.groupId,
        storyId: story.id,
        tehranDate: today,
        textSnapshot: story.text,
        fearReward,
        foundAt: now,
        expiresAt,
        platform: input.platform,
        messageChatId: input.chatId,
      })
      .returning({ id: ghostEncounters.id });
    if (!encounter) throw new Error('encounter insert returned nothing');
    await postTransaction(tx, {
      kind: 'ghost_search',
      effectiveAt: now,
      userId: input.userId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [],
      metadata: { found: true, encounterId: encounter.id, fearReward },
    });
    return {
      status: 'found',
      encounterId: encounter.id,
      text: story.text,
      fearReward,
      expiresAt,
      foundToday: newFound,
      dailyLimit: config.ghosts.dailyLimit,
      nextAvailableAt,
    };
  });
}

/** Called after the ghost message is delivered: «شنیدم» must reply to this message. */
export async function attachEncounterMessage(
  ctx: DomainContext,
  input: { encounterId: number; messageId: string },
): Promise<void> {
  await ctx.db
    .update(ghostEncounters)
    .set({ messageId: input.messageId })
    .where(and(eq(ghostEncounters.id, input.encounterId), isNull(ghostEncounters.messageId)));
}

export type HeardResult =
  | { status: 'ok'; fearReward: number; totalFear: number }
  /** «شنیدم» typed without replying to a message: show guidance only. */
  | { status: 'no_reply' }
  | { status: 'not_a_ghost' }
  /** A reply to a ghost of another group's city. */
  | { status: 'wrong_group' }
  | { status: 'not_owner' }
  | { status: 'already_heard' }
  | { status: 'expired' }
  | { status: 'banned' };

/**
 * «شنیدم» as a reply to the ghost message. Only the ghost's owner is rewarded, only
 * once, and only before the deadline, and only as a reply to the original ghost message
 * in the chat where it was posted (never another group or a forwarded copy). Switching the live batch never invalidates an
 * encounter: the text and reward were stored with it.
 */
export async function hearGhost(
  ctx: DomainContext,
  input: {
    userId: number;
    /** Group of the chat the «شنیدم» was sent in (resolved through chat-id history). */
    groupId: number;
    platform: Platform;
    /** Chat of the replied-to message (see ReplyTarget.chatId). */
    replyChatId: string | null;
    replyToMessageId: string | null;
    /**
     * Whether the replied-to message was sent by this bot. A forwarded copy of a ghost
     * is a message by whoever forwarded it, so it never counts.
     */
    replyFromThisBot: boolean;
  },
): Promise<HeardResult> {
  if (input.replyToMessageId === null || input.replyChatId === null) return { status: 'no_reply' };
  if (!input.replyFromThisBot) return { status: 'not_a_ghost' };
  const now = ctx.clock.now();
  const columns = {
    id: ghostEncounters.id,
    userId: ghostEncounters.userId,
    groupId: ghostEncounters.groupId,
  };
  const [original] = await ctx.db
    .select(columns)
    .from(ghostEncounters)
    .where(
      and(
        eq(ghostEncounters.platform, input.platform),
        eq(ghostEncounters.messageChatId, input.replyChatId),
        eq(ghostEncounters.messageId, input.replyToMessageId),
      ),
    );
  // …or a re-post of it (see ghost_message_refs).
  const [repost] = original
    ? []
    : await ctx.db
        .select(columns)
        .from(ghostMessageRefs)
        .innerJoin(ghostEncounters, eq(ghostEncounters.id, ghostMessageRefs.encounterId))
        .where(
          and(
            eq(ghostMessageRefs.platform, input.platform),
            eq(ghostMessageRefs.chatId, input.replyChatId),
            eq(ghostMessageRefs.messageId, input.replyToMessageId),
          ),
        );
  const found = original ?? repost;
  if (!found) return { status: 'not_a_ghost' };
  // The ghost belongs to the city it was found in; a reply from another group (for
  // example via a cross-chat reply) never counts. A migrated group keeps its id.
  if (found.groupId !== input.groupId) return { status: 'wrong_group' };
  if (found.userId !== input.userId) return { status: 'not_owner' };

  return inTransaction(ctx.db, async (tx) => {
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    const [encounter] = await tx
      .select()
      .from(ghostEncounters)
      .where(eq(ghostEncounters.id, found.id))
      .for('update');
    if (!encounter) return { status: 'not_a_ghost' };
    if (encounter.heardAt) return { status: 'already_heard' };
    if (now.getTime() >= encounter.expiresAt.getTime()) return { status: 'expired' };

    await tx
      .update(ghostEncounters)
      .set({ heardAt: now })
      .where(eq(ghostEncounters.id, encounter.id));
    const [state] = await tx
      .update(playerState)
      .set({ fear: sql`${playerState.fear} + ${encounter.fearReward}`, updatedAt: now })
      .where(eq(playerState.userId, input.userId))
      .returning({ fear: playerState.fear });
    await postTransaction(tx, {
      kind: 'ghost_heard',
      effectiveAt: now,
      userId: input.userId,
      groupId: encounter.groupId,
      entries: [],
      metadata: { encounterId: encounter.id, fearReward: encounter.fearReward },
    });
    return { status: 'ok', fearReward: encounter.fearReward, totalFear: state?.fear ?? 0 };
  });
}

/** Links another message showing the same ghost (a re-post) to its encounter. */
export async function addEncounterMessageRef(
  ctx: DomainContext,
  input: { encounterId: number; platform: Platform; chatId: string; messageId: string },
): Promise<void> {
  await ctx.db
    .insert(ghostMessageRefs)
    .values({
      encounterId: input.encounterId,
      platform: input.platform,
      chatId: input.chatId,
      messageId: input.messageId,
      createdAt: ctx.clock.now(),
    })
    .onConflictDoNothing();
}

export interface OpenEncounter {
  encounterId: number;
  userId: number;
  /** Untrusted display text. */
  ownerName: string;
  text: string;
  fearReward: number;
  expiresAt: Date;
}

/** Ghosts of a group that can still be answered (unheard, before their deadline). */
export async function openEncountersOfGroup(
  ctx: DomainContext,
  groupId: number,
): Promise<OpenEncounter[]> {
  const rows = await ctx.db
    .select({
      encounterId: ghostEncounters.id,
      userId: ghostEncounters.userId,
      ownerName: users.displayName,
      text: ghostEncounters.textSnapshot,
      fearReward: ghostEncounters.fearReward,
      expiresAt: ghostEncounters.expiresAt,
    })
    .from(ghostEncounters)
    .innerJoin(users, eq(users.id, ghostEncounters.userId))
    .where(
      and(
        eq(ghostEncounters.groupId, groupId),
        isNull(ghostEncounters.heardAt),
        gt(ghostEncounters.expiresAt, ctx.clock.now()),
      ),
    )
    .orderBy(ghostEncounters.id);
  return rows;
}
