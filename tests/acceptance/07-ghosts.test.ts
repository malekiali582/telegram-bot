/**
 * Acceptance 7 (spec §19.7): at most three ghosts per Tehran day across all groups,
 * the midnight reset, the chance decay and its reset, and «شنیدم» only by the owner
 * and only once.
 */
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { cooldowns, dailyGhostState, playerState } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import type { GhostSearchResult } from '@lulu/domain';
import {
  attachEncounterMessage,
  ghostChance,
  hearGhost,
  importGhostBatch,
  searchGhost,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
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
const DAY1 = '2026-10-02';
const DAY2 = '2026-10-03';
const MIN = 60_000;

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
  game.rng.fallback = 'min'; // roll 0 → found, first story, fear 10
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
const fearOf = async (userId: number) =>
  (await game.ctx.db.select().from(playerState).where(eq(playerState.userId, userId)))[0]?.fear;

describe(`acceptance 7 — ghost quota and chance (${testBackend()})`, () => {
  it('caps found ghosts at three per Tehran day across all groups, quota used even unheard', async () => {
    at(DAY1, '09:00:00');
    const userId = await newPlayer(game);
    await found(userId, groupA);
    game.clock.advance(30 * MIN);
    await found(userId, groupB);
    game.clock.advance(30 * MIN);
    expect(await found(userId, groupA)).toMatchObject({ foundToday: 3, dailyLimit: 3 });
    game.clock.advance(30 * MIN);
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

  it('keeps the 30-minute cooldown across midnight while the counters reset', async () => {
    at(DAY1, '23:50:00');
    const userId = await newPlayer(game);
    game.rng.push(9_999); // not found
    expect(await search(userId)).toMatchObject({ status: 'not_found', consecutiveFailures: 1 });
    at(DAY2, '00:10:00');
    expect(await search(userId)).toMatchObject({ status: 'cooldown', remainingMs: 10 * MIN });
    at(DAY2, '00:20:00');
    // the failure of yesterday is forgotten: base chance 30 % → roll 2999 succeeds
    game.rng.push(2_999);
    expect((await search(userId)).status).toBe('found');
  });

  it('multiplies the chance by 0.9 after each failure, floors at 10 %, resets on success', () => {
    const pct = (f: number, city = 1) => {
      const c = ghostChance(DEFAULT_GAME_CONFIG, city, f);
      return Number(c.numerator) / Number(c.denominator);
    };
    expect(pct(0)).toBe(0.3);
    expect(pct(1)).toBeCloseTo(0.27, 15);
    expect(pct(2)).toBeCloseTo(0.243, 15);
    expect(pct(10)).toBeCloseTo(0.3 * 0.9 ** 10, 15); // 10.46 %
    expect(pct(11)).toBe(0.1); // 0.3 × 0.9^11 = 9.4 % → floor
    expect(pct(40)).toBe(0.1);
    expect([1, 2, 3, 4, 5].map((city) => pct(0, city))).toEqual([0.3, 0.32, 0.34, 0.36, 0.38]);
  });

  it('applies the decayed chance exactly to the roll, then returns to base after a find', async () => {
    at(DAY1, '10:00:00');
    const userId = await newPlayer(game);
    const step = async (roll: number) => {
      game.rng.push(roll);
      const r: GhostSearchResult = await search(userId);
      game.clock.advance(30 * MIN);
      return r;
    };
    expect(await step(3_000)).toMatchObject({
      status: 'not_found',
      nextChance: { numerator: 27_000_000n, denominator: 100_000_000n },
    });
    expect((await step(2_700)).status).toBe('not_found'); // 27 % → 2700 just misses
    expect((await step(2_429)).status).toBe('found'); // 24.3 % → 2429 hits
    const [state] = await game.ctx.db
      .select()
      .from(dailyGhostState)
      .where(eq(dailyGhostState.userId, userId));
    expect(state).toMatchObject({ foundCount: 1, consecutiveFailures: 0 });
    expect((await step(2_999)).status).toBe('found'); // back to 30 %
  });

  it('a bigger city gives a higher base chance (city level 3 → 34 %)', async () => {
    const { settlements } = await import('@lulu/database');
    const city = await newGroup(game, 'آباد');
    await game.ctx.db.update(settlements).set({ level: 3 }).where(eq(settlements.groupId, city));
    at(DAY1, '11:00:00');
    const userId = await newPlayer(game);
    game.rng.push(3_399);
    expect((await search(userId, city)).status).toBe('found');
  });
});

describe(`acceptance 7 — «شنیدم» (${testBackend()})`, () => {
  async function ghostWithMessage(messageId: string) {
    at(DAY1, '12:00:00');
    const owner = await newPlayer(game, 'صاحب');
    const ghost = await found(owner);
    await attachEncounterMessage(game.ctx, { encounterId: ghost.encounterId, messageId });
    return { owner, ghost };
  }
  const reply = (userId: number, messageId: string | null, groupId = groupA) =>
    hearGhost(game.ctx, {
      userId,
      platform: 'telegram',
      chatId: `chat-${groupId}`,
      replyToMessageId: messageId,
    });

  it('rewards only the owner, only once, with the fear fixed when it was found', async () => {
    const { owner, ghost } = await ghostWithMessage('m-1');
    expect(ghost.fearReward).toBe(DEFAULT_GAME_CONFIG.ghosts.fearMin);
    const stranger = await newPlayer(game, 'غریبه');
    expect(await reply(stranger, 'm-1')).toEqual({ status: 'not_owner' });
    expect(await fearOf(stranger)).toBe(0);
    expect(await reply(owner, 'm-1')).toEqual({ status: 'ok', fearReward: 10, totalFear: 10 });
    expect(await reply(owner, 'm-1')).toEqual({ status: 'already_heard' });
    expect(await fearOf(owner)).toBe(10);
  });

  it('only guides on a bare «شنیدم» or a reply to some other message', async () => {
    const { owner } = await ghostWithMessage('m-2');
    expect(await reply(owner, null)).toEqual({ status: 'no_reply' });
    expect(await reply(owner, 'not-a-ghost')).toEqual({ status: 'not_a_ghost' });
    expect(await reply(owner, 'm-2', groupB)).toEqual({ status: 'not_a_ghost' }); // same id, other chat
    expect(await fearOf(owner)).toBe(0);
  });

  it('accepts the answer until 24 h after finding it, not at 24 h', async () => {
    const { owner, ghost } = await ghostWithMessage('m-3');
    game.clock.set(new Date(ghost.expiresAt.getTime() - 1));
    const { owner: other, ghost: otherGhost } = await ghostWithMessage('m-4');
    game.clock.set(new Date(ghost.expiresAt.getTime() - 1));
    expect((await reply(owner, 'm-3')).status).toBe('ok');
    game.clock.set(otherGhost.expiresAt);
    expect(await reply(other, 'm-4')).toEqual({ status: 'expired' });
  });

  it('pays once when the owner sends «شنیدم» five times at the same moment', async () => {
    const { owner } = await ghostWithMessage('m-5');
    const results = await Promise.all(Array.from({ length: 5 }, () => reply(owner, 'm-5')));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_heard')).toHaveLength(4);
    expect(await fearOf(owner)).toBe(10);
  });
});

describe('acceptance 7 — no content', () => {
  it('without a live batch, consumes no quota, cooldown or failure count', async () => {
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
