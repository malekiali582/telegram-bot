/**
 * Acceptance 12 (spec §19.12): the city survives removing and re-adding the bot, and a
 * migration to a supergroup keeps the same city. Also: «شنیدم» on a ghost message posted
 * before the migration keeps working, and only in its own city.
 */
import { groups, outbox, pendingConfirmations } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import {
  attachEncounterMessage,
  botRemovedFromGroup,
  cityView,
  findGroupIdByChat,
  hearGhost,
  importGhostBatch,
  migrateGroupChat,
  registerGroup,
  searchGhost,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  activeMembers,
  createTestGame,
  fundBloodBank,
  ghostBatchInput,
  newGroupWithChat,
  newPlayer,
  tehranTime,
} from '@lulu/domain/testing';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
  game.clock.set(tehranTime('2026-10-02', '10:00:00'));
  await importGhostBatch(game.ctx, ghostBatchInput('2026-10-02'), { source: 'file' });
});
afterAll(async () => {
  await game.close();
});

const tg = 'telegram' as const;
const register = (chatId: string, title = 'شهر') =>
  registerGroup(game.ctx, { platform: tg, platformChatId: chatId, title });
const migrate = (fromChatId: string, toChatId: string) =>
  migrateGroupChat(game.ctx, { platform: tg, fromChatId, toChatId });
const groupCount = async () => (await game.ctx.db.select({ n: count() }).from(groups))[0]?.n ?? 0;

describe(`acceptance 12 — removing and re-adding the bot (${testBackend()})`, () => {
  it('keeps the city and all its data, and reuses it on re-add', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    await activeMembers(game, groupId, 2);
    await fundBloodBank(game, groupId, 1_234);
    const before = await cityView(game.ctx, groupId);

    expect(await botRemovedFromGroup(game.ctx, { platform: tg, platformChatId: chatId })).toEqual({
      status: 'ok',
      groupId,
    });
    const [removed] = await game.ctx.db.select().from(groups).where(eq(groups.id, groupId));
    expect(removed?.botStatus).toBe('removed');

    const cities = await groupCount();
    expect(await register(chatId)).toEqual({ groupId, created: false });
    expect(await register(chatId)).toEqual({ groupId, created: false }); // repeated event
    expect(await groupCount()).toBe(cities);
    expect(await cityView(game.ctx, groupId)).toEqual(before);
  });
});

describe(`acceptance 12 — supergroup migration (${testBackend()})`, () => {
  it('continues the same city under the new chat id; the old id still resolves', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    await fundBloodBank(game, groupId, 500);
    const newChat = `${chatId}-super`;
    const cities = await groupCount();

    expect(await migrate(chatId, newChat)).toEqual({
      status: 'migrated',
      groupId,
      absorbedGroupId: null,
    });
    expect(await findGroupIdByChat(game.ctx.db, tg, newChat)).toBe(groupId);
    expect(await findGroupIdByChat(game.ctx.db, tg, chatId)).toBe(groupId); // late updates
    expect(await register(newChat)).toEqual({ groupId, created: false });
    expect(await register(chatId)).toEqual({ groupId, created: false });
    expect(await groupCount()).toBe(cities);
    expect((await cityView(game.ctx, groupId)).bloodBank.balanceCenti).toBe(50_000n);
  });

  it('is idempotent and safe when both migration updates arrive at once', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    const results = await Promise.all([
      migrate(chatId, `${chatId}-s`),
      migrate(chatId, `${chatId}-s`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['already_migrated', 'migrated']);
    expect(await migrate(chatId, `${chatId}-s`)).toEqual({ status: 'already_migrated', groupId });
    expect(await migrate('-100nope', '-100nope-s')).toEqual({ status: 'unknown_group' });
  });

  it('absorbs an empty city that was created for the new chat before the migration was seen', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    const newChat = `${chatId}-early`;
    const { groupId: early } = await register(newChat);
    const cities = await groupCount();
    expect(await migrate(chatId, newChat)).toEqual({
      status: 'migrated',
      groupId,
      absorbedGroupId: early,
    });
    expect(await groupCount()).toBe(cities - 1);
    expect(await findGroupIdByChat(game.ctx.db, tg, newChat)).toBe(groupId);
  });

  it('never silently merges into a city that already has real data', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    const newChat = `${chatId}-busy`;
    const { groupId: busy } = await register(newChat);
    await activeMembers(game, busy, 1);
    expect(await migrate(chatId, newChat)).toEqual({
      status: 'conflict',
      groupId,
      otherGroupId: busy,
    });
    expect(await findGroupIdByChat(game.ctx.db, tg, chatId)).toBe(groupId); // nothing changed
  });

  it('re-addresses pending messages and confirmation buttons to the new chat', async () => {
    const { groupId, chatId } = await newGroupWithChat(game);
    const userId = await newPlayer(game);
    const [pending] = await game.ctx.db
      .insert(outbox)
      .values({ platform: tg, kind: 'send', payload: { platformChatId: chatId, text: 'x' } })
      .returning();
    const [sent] = await game.ctx.db
      .insert(outbox)
      .values({
        platform: tg,
        kind: 'send',
        status: 'sent',
        payload: { platformChatId: chatId, text: 'y' },
      })
      .returning();
    const now = game.clock.now();
    await game.ctx.db.insert(pendingConfirmations).values({
      token: 'tok-0123456789abcdef',
      userId,
      action: 'donate_blood',
      groupId,
      platform: tg,
      chatId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 120_000),
    });

    await migrate(chatId, `${chatId}-s`);
    const rows = await game.ctx.db.select().from(outbox);
    expect(rows.find((r) => r.id === pending!.id)?.payload).toEqual({
      platformChatId: `${chatId}-s`,
      text: 'x',
    });
    expect(rows.find((r) => r.id === sent!.id)?.payload).toEqual({
      platformChatId: chatId,
      text: 'y',
    });
    const [confirmation] = await game.ctx.db
      .select()
      .from(pendingConfirmations)
      .where(eq(pendingConfirmations.token, 'tok-0123456789abcdef'));
    expect(confirmation?.chatId).toBe(`${chatId}-s`);
  });
});

describe(`acceptance 12 — «شنیدم» after a migration (${testBackend()})`, () => {
  it('still works on a ghost message posted before the migration, only in that city', async () => {
    game.rng.fallback = 'min';
    const { groupId, chatId } = await newGroupWithChat(game);
    const { groupId: otherGroup } = await newGroupWithChat(game);
    const owner = await newPlayer(game);
    const ghost = await searchGhost(game.ctx, { userId: owner, groupId, platform: tg, chatId });
    if (ghost.status !== 'found') throw new Error(ghost.status);
    await attachEncounterMessage(game.ctx, { encounterId: ghost.encounterId, messageId: '501' });

    const newChat = `${chatId}-super`;
    await migrate(chatId, newChat);
    const groupOfNewChat = await findGroupIdByChat(game.ctx.db, tg, newChat);
    expect(groupOfNewChat).toBe(groupId);

    const heard = (inGroup: number, replyChatId: string) =>
      hearGhost(game.ctx, {
        userId: owner,
        groupId: inGroup,
        platform: tg,
        replyChatId,
        replyToMessageId: '501',
        replyFromThisBot: true,
      });
    // the same message id in the new chat is a different message
    expect(await heard(groupId, newChat)).toEqual({ status: 'not_a_ghost' });
    // a cross-chat reply to the old message from another city does not count
    expect(await heard(otherGroup, chatId)).toEqual({ status: 'wrong_group' });
    // replying in the migrated supergroup to the pre-migration message works
    expect(await heard(groupId, chatId)).toMatchObject({
      status: 'ok',
      rewardPerMemberCenti: 5_000n,
    });
    expect(await heard(groupId, chatId)).toEqual({ status: 'already_heard' });
  });
});
