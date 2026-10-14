import { auditLogs, groupMigrations } from '@lulu/database';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminGroupDetail,
  migrationOverview,
  reviewMigrationConflict,
  searchGroups,
  setGroupDisabled,
} from './admin-groups.ts';
import { botRemovedFromGroup, migrateGroupChat } from './group-lifecycle.ts';
import { groupGate, registerGroup } from './groups.ts';
import { claimLolo } from './lolo.ts';
import type { TestGame } from './testing.ts';
import { createAdminUser, createTestGame, newGroupWithChat, newPlayer } from './testing.ts';

let game: TestGame;
let admin: number;
beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  admin = await createAdminUser(game);
});
afterEach(async () => {
  await game.close();
});

const titles = async (input: Partial<Parameters<typeof searchGroups>[1]> = {}) =>
  (await searchGroups(game.ctx, { limit: 50, offset: 0, ...input })).items.map((g) => g.title);

describe('group search', () => {
  it('finds groups by title (Arabic or Persian letters), id, current or old chat id', async () => {
    const a = await newGroupWithChat(game, 'كوچهٔ تاريك'); // Arabic kaf and yeh
    await newGroupWithChat(game, 'برج');
    await migrateGroupChat(game.ctx, {
      platform: 'telegram',
      fromChatId: a.chatId,
      toChatId: '-100555',
    });

    expect(await titles({ query: 'کوچه' })).toEqual(['كوچهٔ تاريك']);
    expect(await titles({ query: String(a.groupId) })).toContain('كوچهٔ تاريك');
    expect(await titles({ query: '-100555' })).toEqual(['كوچهٔ تاريك']);
    expect(await titles({ query: a.chatId })).toEqual(['كوچهٔ تاريك']);
    const [found] = (await searchGroups(game.ctx, { query: 'کوچه', limit: 5, offset: 0 })).items;
    expect(found).toMatchObject({ chatId: '-100555', previousChatIds: 1, platform: 'telegram' });
  });

  it('filters active, disabled and bot-removed groups, and counts members', async () => {
    const live = await newGroupWithChat(game, 'زنده');
    const off = await newGroupWithChat(game, 'خاموش');
    const gone = await newGroupWithChat(game, 'رفته');
    await registerGroup(game.ctx, {
      platform: 'rubika',
      platformChatId: 'g0r1',
      title: 'روبیکایی',
    });
    for (let i = 0; i < 3; i++) {
      await claimLolo(game.ctx, { userId: await newPlayer(game), groupId: live.groupId });
    }
    await setGroupDisabled(game.ctx, {
      groupId: off.groupId,
      disabled: true,
      reason: 'تبلیغات',
      adminUserId: admin,
    });
    await botRemovedFromGroup(game.ctx, { platform: 'telegram', platformChatId: gone.chatId });

    expect((await titles({ status: 'active' })).sort()).toEqual(['روبیکایی', 'زنده']);
    expect(await titles({ status: 'disabled' })).toEqual(['خاموش']);
    expect(await titles({ status: 'removed' })).toEqual(['رفته']);
    expect(await titles({ platform: 'rubika' })).toEqual(['روبیکایی']);
    const [top] = (await searchGroups(game.ctx, { sort: 'members', limit: 1, offset: 0 })).items;
    expect(top).toMatchObject({ title: 'زنده', members: 3, activeMembers: 3, botPresent: true });
  });
});

describe('disabling a group', () => {
  it('needs a reason, is audited, and closes the bot there with a throttled notice', async () => {
    const { groupId } = await newGroupWithChat(game);
    const set = (disabled: boolean, reason = 'دلیل') =>
      setGroupDisabled(game.ctx, { groupId, disabled, reason, adminUserId: admin });
    expect(await set(true, '  ')).toEqual({ status: 'reason_required' });
    expect(await groupGate(game.ctx.db, groupId, game.clock.now())).toEqual({ disabled: false });

    expect(await set(true, 'اسپم')).toEqual({ status: 'ok' });
    expect(await set(true)).toEqual({ status: 'unchanged' });
    const now = () => game.clock.now();
    expect(await groupGate(game.ctx.db, groupId, now())).toEqual({ disabled: true, notify: true });
    game.clock.advance(9 * 60_000);
    expect(await groupGate(game.ctx.db, groupId, now())).toEqual({ disabled: true, notify: false });
    game.clock.advance(2 * 60_000);
    expect(await groupGate(game.ctx.db, groupId, now())).toEqual({ disabled: true, notify: true });

    const detail = await adminGroupDetail(game.ctx, groupId);
    expect(detail!.group).toMatchObject({ disabledReason: 'اسپم' });
    expect(await set(false, 'رفع شد')).toEqual({ status: 'ok' });
    expect(await groupGate(game.ctx.db, groupId, now())).toEqual({ disabled: false });

    const actions = (await game.ctx.db.select().from(auditLogs)).map((a) => [a.action, a.reason]);
    expect(actions).toEqual([
      ['group.disable', 'اسپم'],
      ['group.enable', 'رفع شد'],
    ]);
    expect(
      await setGroupDisabled(game.ctx, {
        groupId: 9999,
        disabled: true,
        reason: 'x',
        adminUserId: admin,
      }),
    ).toEqual({
      status: 'not_found',
    });
  });
});

describe('group detail', () => {
  it('shows the city, members, leaderboard and chat id history', async () => {
    const { groupId, chatId } = await newGroupWithChat(game, 'لولوآباد');
    const p = await newPlayer(game, 'فعال');
    await claimLolo(game.ctx, { userId: p, groupId });
    await newPlayer(game, 'بی‌ربط');
    await migrateGroupChat(game.ctx, {
      platform: 'telegram',
      fromChatId: chatId,
      toChatId: '-100777',
    });

    const d = await adminGroupDetail(game.ctx, groupId);
    expect(d!.identity).toMatchObject({ platform: 'telegram', chatId: '-100777' });
    expect(d!.previousChatIds).toEqual([expect.objectContaining({ chatId })]);
    expect(d!.city.level).toBe(1);
    expect(d!.members).toMatchObject({ total: 1, active: 1, left: 0 });
    expect(d!.members.list[0]).toMatchObject({ userId: p, displayName: 'فعال', active: true });
    expect(d!.leaderboard.map((e) => e.userId)).toEqual([p]);
    expect(d!.migrations).toEqual([
      expect.objectContaining({ status: 'migrated', fromChatId: chatId, toChatId: '-100777' }),
    ]);
    expect(await adminGroupDetail(game.ctx, 9999)).toBeNull();
  });
});

describe('migration record', () => {
  it('records an absorbed empty city, and a conflict once until reviewed', async () => {
    // The new chat id already has an unused city: it is folded in and recorded.
    const a = await newGroupWithChat(game, 'الف');
    const pristine = await registerGroup(game.ctx, {
      platform: 'telegram',
      platformChatId: '-100901',
      title: 'تازه',
    });
    const merged = await migrateGroupChat(game.ctx, {
      platform: 'telegram',
      fromChatId: a.chatId,
      toChatId: '-100901',
    });
    expect(merged).toMatchObject({ status: 'migrated', absorbedGroupId: pristine.groupId });

    // The new chat id has a city with real data: nothing moves; one open conflict.
    const b = await newGroupWithChat(game, 'ب');
    const busy = await newGroupWithChat(game, 'پر');
    await claimLolo(game.ctx, { userId: await newPlayer(game), groupId: busy.groupId });
    for (let i = 0; i < 2; i++) {
      const r = await migrateGroupChat(game.ctx, {
        platform: 'telegram',
        fromChatId: b.chatId,
        toChatId: busy.chatId,
      });
      expect(r).toEqual({ status: 'conflict', groupId: b.groupId, otherGroupId: busy.groupId });
    }

    let o = await migrationOverview(game.ctx);
    expect(o.openConflicts).toHaveLength(1);
    expect(o.openConflicts[0]).toMatchObject({
      groupTitle: 'ب',
      otherGroup: { id: busy.groupId, title: 'پر' },
      review: null,
    });
    expect(o.recent.map((m) => m.status)).toEqual(['conflict', 'migrated']);
    expect(o.recent[1]).toMatchObject({ absorbedGroupId: pristine.groupId });
    expect(o.groupsWithPreviousIds.map((g) => g.title)).toEqual(['الف']);

    const id = o.openConflicts[0]!.id;
    expect(
      await reviewMigrationConflict(game.ctx, { migrationId: id, note: ' ', adminUserId: admin }),
    ).toEqual({
      status: 'note_required',
    });
    expect(
      await reviewMigrationConflict(game.ctx, {
        migrationId: id,
        note: 'دو گروه جدا بمانند',
        adminUserId: admin,
      }),
    ).toEqual({ status: 'ok' });
    expect(
      await reviewMigrationConflict(game.ctx, { migrationId: id, note: 'باز', adminUserId: admin }),
    ).toEqual({
      status: 'not_found',
    });
    o = await migrationOverview(game.ctx);
    expect(o.openConflicts).toEqual([]);
    const [row] = await game.ctx.db
      .select()
      .from(groupMigrations)
      .where(eq(groupMigrations.id, id));
    expect(row).toMatchObject({ reviewNote: 'دو گروه جدا بمانند', reviewedByAdminId: admin });

    // A new conflict for the same chats after the review is recorded again.
    await migrateGroupChat(game.ctx, {
      platform: 'telegram',
      fromChatId: b.chatId,
      toChatId: busy.chatId,
    });
    expect((await migrationOverview(game.ctx)).openConflicts).toHaveLength(1);
  });
});
