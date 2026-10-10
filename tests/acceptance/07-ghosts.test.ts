/**
 * Acceptance 7 (spec §19.7): per Tehran day across all groups, 10 search attempts 10
 * minutes apart and at most three ghosts found; the midnight reset; the chance falling
 * by one point per failure and its reset; «شنیدم» only by the finder, only once, paying
 * every active member of the group.
 */
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { cooldowns, dailyGhostState, settlements } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import type { GhostSearchResult } from '@lulu/domain';
import {
  attachEncounterMessage,
  claimLolo,
  ghostChance,
  hearGhost,
  importGhostBatch,
  memberLeftGroup,
  searchGhost,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  banPlayer,
  cashOf,
  createTestGame,
  ghostBatchInput,
  newGroup,
  newPlayer,
  tehranTime,
} from '@lulu/domain/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let groupA: number;
let groupB: number;
const DAY0 = '2026-09-24';
const DAY1 = '2026-10-02';
const DAY2 = '2026-10-03';
const MIN = 60_000;
const COOLDOWN = 10 * MIN;

beforeAll(async () => {
  game = await createTestGame();
  game.clock.set(tehranTime(DAY1, '08:00:00'));
  groupA = await newGroup(game, 'الف');
  groupB = await newGroup(game, 'ب');
  expect((await importGhostBatch(game.ctx, ghostBatchInput(DAY1), { source: 'file' })).status).toBe(
    'imported',
  );
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.rng.fallback = 'min'; // roll 0 → found, first story
});

const at = (date: string, time: string) => game.clock.set(tehranTime(date, time));
const search = (userId: number, groupId = groupA) =>
  searchGhost(game.ctx, { userId, groupId, platform: 'telegram', chatId: `chat-${groupId}` });
const found = async (userId: number, groupId = groupA) => {
  const r = await search(userId, groupId);
  if (r.status !== 'found') throw new Error(`expected found, got ${r.status}`);
  return r;
};
const ghostCooldown = async (userId: number) =>
  (
    await game.ctx.db
      .select()
      .from(cooldowns)
      .where(and(eq(cooldowns.userId, userId), eq(cooldowns.kind, 'ghost')))
  )[0]?.availableAt;

describe(`acceptance 7 — ghost attempts, quota and chance (${testBackend()})`, () => {
  it('caps found ghosts at three per Tehran day across all groups, quota used even unheard', async () => {
    at(DAY1, '09:00:00');
    const userId = await newPlayer(game);
    await found(userId, groupA);
    game.clock.advance(COOLDOWN);
    await found(userId, groupB);
    game.clock.advance(COOLDOWN);
    expect(await found(userId, groupA)).toMatchObject({ foundToday: 3, dailyLimit: 3 });
    game.clock.advance(COOLDOWN);
    const cooldownBefore = await ghostCooldown(userId);
    expect(await search(userId, groupB)).toEqual({
      status: 'daily_limit',
      dailyLimit: 3,
      resetsAt: tehranTime(DAY2, '00:00:00'),
    });
    // a capped request is not an attempt: no cooldown used
    expect(await ghostCooldown(userId)).toEqual(cooldownBefore);

    at(DAY2, '00:00:00');
    expect(await found(userId, groupB)).toMatchObject({ foundToday: 1 });
  });

  it('allows 10 attempts per Tehran day across all groups, 10 minutes apart', async () => {
    at(DAY1, '13:00:00');
    const userId = await newPlayer(game);
    const left: number[] = [];
    for (let i = 0; i < 10; i++) {
      game.rng.push(9_999); // never found
      const r = await search(userId, i % 2 ? groupB : groupA);
      if (r.status !== 'not_found') throw new Error(r.status);
      left.push(r.attemptsLeft);
      if (r.attemptsLeft > 0) {
        expect(await search(userId, groupB)).toMatchObject({
          status: 'cooldown',
          remainingMs: COOLDOWN,
        });
        game.clock.advance(COOLDOWN - 1);
        expect((await search(userId)).status).toBe('cooldown');
      } else {
        game.clock.advance(COOLDOWN - 1);
      }
      game.clock.advance(1);
    }
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const cooldownBefore = await ghostCooldown(userId);
    expect(await search(userId)).toEqual({
      status: 'no_attempts',
      dailyAttempts: 10,
      resetsAt: tehranTime(DAY2, '00:00:00'),
    });
    expect(await ghostCooldown(userId)).toEqual(cooldownBefore); // no 11th attempt was made
    const [state] = await game.ctx.db
      .select()
      .from(dailyGhostState)
      .where(eq(dailyGhostState.userId, userId));
    expect(state).toMatchObject({ attempts: 10, foundCount: 0, consecutiveFailures: 10 });

    at(DAY2, '00:00:00'); // a new day: attempts and failures start over, at 30 %
    game.rng.push(2_999);
    expect(await search(userId)).toMatchObject({ status: 'found', attemptsLeft: 9 });
  });

  it('keeps the 10-minute cooldown across midnight while the counters reset', async () => {
    at(DAY1, '23:55:00');
    const userId = await newPlayer(game);
    game.rng.push(9_999); // not found
    expect(await search(userId)).toMatchObject({ status: 'not_found', consecutiveFailures: 1 });
    at(DAY2, '00:00:00');
    expect(await search(userId)).toMatchObject({ status: 'cooldown', remainingMs: 5 * MIN });
    at(DAY2, '00:05:00');
    // the failure of yesterday is forgotten: base chance 30 % → roll 2999 succeeds
    game.rng.push(2_999);
    expect((await search(userId)).status).toBe('found');
  });

  it('loses one percentage point per failure (30, 29, 28 …), floors at 10 %, city bonus kept', () => {
    const bp = (failures: number, city = 1) =>
      Number(ghostChance(DEFAULT_GAME_CONFIG, city, failures).numerator);
    expect([0, 1, 2, 3, 9].map((f) => bp(f))).toEqual([3_000, 2_900, 2_800, 2_700, 2_100]);
    expect(bp(20)).toBe(1_000);
    expect(bp(40)).toBe(1_000);
    expect([1, 2, 3, 4, 5].map((city) => bp(0, city))).toEqual([3_000, 3_200, 3_400, 3_600, 3_800]);
    expect(bp(2, 5)).toBe(3_600);
    expect(ghostChance(DEFAULT_GAME_CONFIG, 1, 0).denominator).toBe(10_000n);
  });

  it('applies the lowered chance exactly to the roll, then returns to 30 % after a find', async () => {
    at(DAY1, '10:00:00');
    const userId = await newPlayer(game);
    const step = async (roll: number) => {
      game.rng.push(roll);
      const r: GhostSearchResult = await search(userId);
      game.clock.advance(COOLDOWN);
      return r;
    };
    expect(await step(3_000)).toMatchObject({
      status: 'not_found',
      nextChance: { numerator: 2_900n, denominator: 10_000n },
    });
    expect((await step(2_900)).status).toBe('not_found'); // 29 % → 2900 just misses
    expect((await step(2_799)).status).toBe('found'); // 28 % → 2799 hits
    const [state] = await game.ctx.db
      .select()
      .from(dailyGhostState)
      .where(eq(dailyGhostState.userId, userId));
    expect(state).toMatchObject({ foundCount: 1, consecutiveFailures: 0, attempts: 3 });
    expect((await step(2_999)).status).toBe('found'); // back to 30 %
  });

  it('a bigger city gives a higher base chance (city level 3 → 34 %)', async () => {
    const city = await newGroup(game, 'آباد');
    await game.ctx.db.update(settlements).set({ level: 3 }).where(eq(settlements.groupId, city));
    at(DAY1, '11:00:00');
    const userId = await newPlayer(game);
    game.rng.push(3_399);
    expect((await search(userId, city)).status).toBe('found');
  });
});

describe(`acceptance 7 — «شنیدم» pays every active member (${testBackend()})`, () => {
  /** A fresh group with a found ghost whose message id is known. */
  async function ghostWithMessage(messageId: string, groupId?: number) {
    const group = groupId ?? (await newGroup(game));
    at(DAY1, '12:00:00');
    const owner = await newPlayer(game, 'صاحب');
    const ghost = await found(owner, group);
    await attachEncounterMessage(game.ctx, { encounterId: ghost.encounterId, messageId });
    return { owner, ghost, group };
  }
  /** «شنیدم» sent in `inGroup`, replying to `messageId` of chat `messageChat` (default: the same chat). */
  const reply = (
    userId: number,
    inGroup: number,
    messageId: string | null,
    opts: { messageChat?: string; fromBot?: boolean } = {},
  ) =>
    hearGhost(game.ctx, {
      userId,
      groupId: inGroup,
      platform: 'telegram',
      replyChatId: messageId === null ? null : (opts.messageChat ?? `chat-${inGroup}`),
      replyToMessageId: messageId,
      replyFromThisBot: opts.fromBot ?? true,
    });
  /** A player with a successful «لولو» in `groupId` at the current time. */
  async function activeIn(groupId: number, name = 'عضو') {
    const userId = await newPlayer(game, name);
    expect((await claimLolo(game.ctx, { userId, groupId })).status).toBe('ok');
    return userId;
  }

  it('gives 50 to each member active in the last 7 days, the finder included, nothing extra', async () => {
    const group = await newGroup(game, 'پاداش');
    at(DAY0, '12:00:00'); // 8 days before DAY1
    const stale = await activeIn(group, 'قدیمی');
    at(DAY1, '09:00:00');
    const m1 = await activeIn(group, 'یک');
    const m2 = await activeIn(group, 'دو');
    const gone = await activeIn(group, 'رفته');
    await memberLeftGroup(game.ctx, { groupId: group, userId: gone });
    const banned = await activeIn(group, 'مسدود');
    await banPlayer(game, banned);
    const elsewhere = await activeIn(groupB, 'گروه دیگر');
    const { owner } = await ghostWithMessage('m-1', group);

    const players = [owner, m1, m2, stale, gone, banned, elsewhere];
    const before = await Promise.all(players.map((u) => cashOf(game, u)));
    expect(await reply(owner, group, 'm-1')).toEqual({
      status: 'ok',
      rewardPerMemberCenti: 5_000n,
      members: 3,
      totalCenti: 15_000n,
    });
    const gained = (await Promise.all(players.map((u) => cashOf(game, u)))).map(
      (c, i) => c - before[i]!,
    );
    // owner, m1, m2: +50 each · inactive for 8 days, gone, banned, other group: nothing
    expect(gained).toEqual([5_000n, 5_000n, 5_000n, 0n, 0n, 0n, 0n]);
  });

  it('pays nobody unless the finder answers: a stranger cannot, and only once', async () => {
    const { owner, group } = await ghostWithMessage('m-7');
    const member = await activeIn(group, 'عضو');
    const before = await cashOf(game, member);
    expect(await reply(member, group, 'm-7')).toEqual({ status: 'not_owner' });
    expect(await cashOf(game, member)).toBe(before);
    expect((await reply(owner, group, 'm-7')).status).toBe('ok');
    expect(await reply(owner, group, 'm-7')).toEqual({ status: 'already_heard' });
    expect(await cashOf(game, member)).toBe(before + 5_000n);
  });

  it('only guides on a bare «شنیدم» or a reply to some other message', async () => {
    const { owner, group } = await ghostWithMessage('m-2');
    const before = await cashOf(game, owner);
    expect(await reply(owner, group, null)).toEqual({ status: 'no_reply' });
    expect(await reply(owner, group, 'not-a-ghost')).toEqual({ status: 'not_a_ghost' });
    expect(await reply(owner, groupB, 'm-2')).toEqual({ status: 'not_a_ghost' }); // same id, other chat
    expect(await cashOf(game, owner)).toBe(before);
  });

  it('ignores replies from another group and forwarded copies of the ghost', async () => {
    const { owner, group } = await ghostWithMessage('m-6');
    const before = await cashOf(game, owner);
    // cross-chat reply sent in group B to the original ghost message
    expect(await reply(owner, groupB, 'm-6', { messageChat: `chat-${group}` })).toEqual({
      status: 'wrong_group',
    });
    // a forwarded copy is a new message, sent by whoever forwarded it
    expect(await reply(owner, group, 'fwd-1', { fromBot: false })).toEqual({
      status: 'not_a_ghost',
    });
    // even a reply carrying the original id does not count unless it is the bot's message
    expect(await reply(owner, group, 'm-6', { fromBot: false })).toEqual({
      status: 'not_a_ghost',
    });
    expect(await cashOf(game, owner)).toBe(before);
    expect((await reply(owner, group, 'm-6')).status).toBe('ok');
  });

  it('accepts the answer until 24 h after finding it, not at 24 h; then nobody is paid', async () => {
    const { owner, ghost, group } = await ghostWithMessage('m-3');
    const { owner: other, ghost: otherGhost, group: otherGroup } = await ghostWithMessage('m-4');
    game.clock.set(new Date(ghost.expiresAt.getTime() - 1));
    expect((await reply(owner, group, 'm-3')).status).toBe('ok');
    game.clock.set(otherGhost.expiresAt);
    const before = await cashOf(game, other);
    expect(await reply(other, otherGroup, 'm-4')).toEqual({ status: 'expired' });
    expect(await cashOf(game, other)).toBe(before);
  });

  it('pays once when the finder sends «شنیدم» five times at the same moment', async () => {
    const { owner, group } = await ghostWithMessage('m-5');
    const before = await cashOf(game, owner);
    const results = await Promise.all(Array.from({ length: 5 }, () => reply(owner, group, 'm-5')));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_heard')).toHaveLength(4);
    expect(await cashOf(game, owner)).toBe(before + 5_000n);
  });
});

describe('acceptance 7 — no content', () => {
  it('without a live batch, consumes no attempt, quota, cooldown or failure count', async () => {
    const empty = await createTestGame();
    try {
      const userId = await newPlayer(empty);
      const group = await newGroup(empty);
      const result = await searchGhost(empty.ctx, {
        userId,
        groupId: group,
        platform: 'telegram',
        chatId: 'c',
      });
      expect(result).toEqual({ status: 'no_content' });
      expect(
        await empty.ctx.db.select().from(cooldowns).where(eq(cooldowns.userId, userId)),
      ).toEqual([]);
      expect(
        await empty.ctx.db.select().from(dailyGhostState).where(eq(dailyGhostState.userId, userId)),
      ).toEqual([]);
    } finally {
      await empty.close();
    }
  });
});
