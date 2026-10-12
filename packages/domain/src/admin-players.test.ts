import { users } from '@lulu/database';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlayerBan } from './admin.ts';
import { adminPlayerDetail, searchPlayers } from './admin-players.ts';
import { activateDueBatches, importGhostBatch } from './ghost-batches.ts';
import { attachEncounterMessage, hearGhost, searchGhost } from './ghosts.ts';
import { claimLolo } from './lolo.ts';
import { registerPlayer } from './players.ts';
import { tehranDate } from './tehran.ts';
import type { TestGame } from './testing.ts';
import {
  createAdminUser,
  createTestGame,
  ghostBatchInput,
  grantPoints,
  newGroupWithChat,
  newPlayer,
  tehranTime,
} from './testing.ts';
import { allTransactions, listTransactions, summarizeTransactions } from './transactions-query.ts';

let game: TestGame;
beforeEach(async () => {
  game = await createTestGame('2026-10-12T08:00:00Z');
});
afterEach(async () => {
  await game.close();
});

async function rubikaPlayer(name: string, id: string): Promise<number> {
  const r = await registerPlayer(game.ctx, {
    platform: 'rubika',
    platformUserId: id,
    displayName: name,
  });
  if (r.status !== 'ok') throw new Error('setup');
  return r.userId;
}

describe('player search', () => {
  it('finds players by name (Arabic or Persian letters), @username, id and platform id', async () => {
    const karim = await newPlayer(game, 'كريم شب‌گرد'); // typed with Arabic kaf and yeh
    const sara = (
      await registerPlayer(game.ctx, {
        platform: 'telegram',
        platformUserId: '777001',
        displayName: 'سارا',
        username: 'sara_lulu',
      })
    ).status;
    expect(sara).toBe('ok');
    const rubi = await rubikaPlayer('روبی', 'u0abc');

    const names = async (query: string) =>
      (await searchPlayers(game.ctx, { query, limit: 20, offset: 0 })).items.map(
        (p) => p.displayName,
      );
    expect(await names('کریم')).toEqual(['كريم شب‌گرد']);
    expect(await names('@sara_lulu')).toEqual(['سارا']);
    expect(await names('lulu')).toEqual(['سارا']);
    expect(await names('777001')).toEqual(['سارا']);
    expect(await names('u0abc')).toEqual(['روبی']);
    expect(await names(String(karim))).toContain('كريم شب‌گرد');
    // LIKE wildcards are plain characters in a search.
    expect(await names('%')).toEqual([]);

    const onRubika = await searchPlayers(game.ctx, { platform: 'rubika', limit: 20, offset: 0 });
    expect(onRubika.items.map((p) => p.id)).toEqual([rubi]);
    expect(onRubika.items[0]!.identities).toEqual([
      { platform: 'rubika', platformUserId: 'u0abc' },
    ]);
  });

  it('filters banned players, sorts and pages with a total', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await newPlayer(game, `لولو ${i}`));
    await grantPoints(game, ids[2]!, 500);
    const admin = await createAdminUser(game);
    await setPlayerBan(game.ctx, {
      userId: ids[4]!,
      banned: true,
      reason: 'تقلب',
      adminUserId: admin,
    });

    const banned = await searchPlayers(game.ctx, { banned: 'only', limit: 10, offset: 0 });
    expect(banned.items.map((p) => p.id)).toEqual([ids[4]]);
    expect(banned.items[0]!.bannedAt).not.toBeNull();
    const clean = await searchPlayers(game.ctx, { banned: 'exclude', limit: 10, offset: 0 });
    expect(clean.total).toBe(4);

    const richest = await searchPlayers(game.ctx, { sort: 'richest', limit: 1, offset: 0 });
    expect(richest.items[0]).toMatchObject({ id: ids[2], cashCenti: 50_000n });
    const newest = await searchPlayers(game.ctx, { sort: 'newest', limit: 2, offset: 2 });
    expect(newest).toMatchObject({ total: 5 });
    expect(newest.items.map((p) => p.id)).toEqual([ids[2], ids[1]]);
  });
});

describe('player detail', () => {
  it('shows identities, groups with live streaks, ghosts and history in one view', async () => {
    const p1 = await newPlayer(game, 'یابنده');
    const p2 = await newPlayer(game, 'هم‌گروه');
    const { groupId, chatId } = await newGroupWithChat(game, 'شهر <i>تاریک</i>');
    await claimLolo(game.ctx, { userId: p1, groupId });
    await claimLolo(game.ctx, { userId: p2, groupId });

    await importGhostBatch(game.ctx, ghostBatchInput(tehranDate(game.clock.now())), {
      source: 'file',
    });
    await activateDueBatches(game.ctx);
    const found = await searchGhost(game.ctx, {
      userId: p1,
      groupId,
      platform: 'telegram',
      chatId,
    });
    if (found.status !== 'found') throw new Error(`ghost: ${found.status}`);
    await attachEncounterMessage(game.ctx, { encounterId: found.encounterId, messageId: '55' });
    const heard = await hearGhost(game.ctx, {
      userId: p1,
      groupId,
      platform: 'telegram',
      replyChatId: chatId,
      replyToMessageId: '55',
      replyFromThisBot: true,
    });
    expect(heard.status).toBe('ok');

    const d = await adminPlayerDetail(game.ctx, p1);
    expect(d).not.toBeNull();
    expect(d!.user).toMatchObject({ id: p1, displayName: 'یابنده', bannedAt: null });
    expect(d!.identities).toHaveLength(1);
    expect(d!.groups).toEqual([
      expect.objectContaining({
        groupId,
        title: 'شهر <i>تاریک</i>',
        platform: 'telegram',
        status: 'member',
        streak: 1,
      }),
    ]);
    expect(d!.ghosts).toMatchObject({ foundTotal: 1, heardTotal: 1 });
    expect(d!.ghosts.recent[0]!.text).toContain('متن');
    expect(d!.profile.level).toBe(1);

    // Two days later the run is broken.
    game.clock.advance(2 * 86_400_000);
    expect((await adminPlayerDetail(game.ctx, p1))!.groups[0]!.streak).toBe(0);
    expect(await adminPlayerDetail(game.ctx, 99_999)).toBeNull();

    // The ghost reward paid p2 too, without p2 starting it: it is in p2's history.
    const forP2 = await listTransactions(game.ctx, { userId: p2 }, { limit: 50 });
    const ghost = forP2.items.find((t) => t.kind === 'ghost_heard');
    expect(ghost).toBeDefined();
    expect(ghost!.user?.id).toBe(p1);
    expect(ghost!.playerDeltaCenti).toBe(5_000n);
  });
});

describe('transaction history', () => {
  it('filters by group, kind, Tehran days and amount', async () => {
    const p = await newPlayer(game);
    const { groupId } = await newGroupWithChat(game);
    game.clock.set(tehranTime('2026-10-12', '23:59:59'));
    await claimLolo(game.ctx, { userId: p, groupId }); // 1 point, on 2026-10-12
    game.clock.set(tehranTime('2026-10-13', '00:00:01'));
    await grantPoints(game, p, 300); // 300 points, on 2026-10-13

    const kinds = async (filter: Parameters<typeof listTransactions>[1]) =>
      (await listTransactions(game.ctx, filter, { limit: 50 })).items.map((t) => t.kind);
    expect(await kinds({ userId: p })).toEqual(['test_grant', 'lolo_reward']);
    expect(await kinds({ userId: p, toDay: '2026-10-12' })).toEqual(['lolo_reward']);
    expect(await kinds({ userId: p, fromDay: '2026-10-13', toDay: '2026-10-13' })).toEqual([
      'test_grant',
    ]);
    expect(await kinds({ groupId })).toEqual(['lolo_reward']);
    expect(await kinds({ kinds: ['test_grant'] })).toEqual(['test_grant']);
    expect(await kinds({ userId: p, minCenti: 1_000n })).toEqual(['test_grant']);
    expect(await kinds({ userId: p, maxCenti: 100n })).toEqual(['lolo_reward']);

    const [grant] = (await listTransactions(game.ctx, { kinds: ['test_grant'] }, { limit: 1 }))
      .items;
    expect(grant).toMatchObject({ amountCenti: 30_000n, playerDeltaCenti: null });
    expect(grant!.entries.map((e) => [e.walletKind, e.systemCode, e.amountCenti])).toEqual([
      ['system', 'adjust:admin', -30_000n],
      ['user_cash', null, 30_000n],
    ]);
    expect(await summarizeTransactions(game.ctx, { userId: p })).toEqual({
      count: 2,
      amountCenti: 30_100n,
    });
  });

  it('pages newest first without gaps or repeats, even within the same instant', async () => {
    const p = await newPlayer(game);
    for (let i = 0; i < 7; i++) await grantPoints(game, p, i + 1); // all at the same instant
    const seen: number[] = [];
    let after;
    for (let pages = 0; pages < 10; pages++) {
      const r = await listTransactions(
        game.ctx,
        { userId: p },
        { limit: 3, ...(after ? { after } : {}) },
      );
      seen.push(...r.items.map((t) => t.id));
      if (!r.next) break;
      after = r.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));

    const streamed: number[] = [];
    for await (const t of allTransactions(game.ctx, { userId: p }, 2)) streamed.push(t.id);
    expect(streamed).toEqual(seen);
  });

  it('records who banned whom with the reason', async () => {
    const p = await newPlayer(game);
    const admin = await createAdminUser(game);
    await setPlayerBan(game.ctx, {
      userId: p,
      banned: true,
      reason: 'چند حساب',
      adminUserId: admin,
    });
    const d = await adminPlayerDetail(game.ctx, p);
    expect(d!.user.banReason).toBe('چند حساب');
    const [row] = await game.ctx.db.select().from(users).where(eq(users.id, p));
    expect(row!.bannedAt).not.toBeNull();
  });
});
