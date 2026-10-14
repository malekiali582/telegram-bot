import { auditLogs } from '@lulu/database';
import { claimLolo, migrateGroupChat } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame, newGroupWithChat, newPlayer } from '@lulu/domain/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  GroupDetailView,
  GroupListView,
  MigrationOverviewView,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let helper: LoggedIn;

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  api = await createTestApi(game);
  await addAdmin(game, 'helper', 'admin');
  helper = await loginAs(api, 'helper');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const get = async <T>(url: string) => {
  const r = await api.app.inject({ method: 'GET', url, headers: { cookie: helper.cookie } });
  return { status: r.statusCode, body: r.json<T>() };
};
const post = async <T>(url: string, payload: object) => {
  const r = await api.app.inject({ method: 'POST', url, headers: helper.writeHeaders, payload });
  return { status: r.statusCode, body: r.json<T>() };
};

describe('groups', () => {
  it('are listed with filters and opened with the city, members and leaderboard', async () => {
    const { groupId } = await newGroupWithChat(game, '<b>لولوآباد</b>');
    await newGroupWithChat(game, 'دیگری');
    await claimLolo(game.ctx, { userId: await newPlayer(game, 'سارا'), groupId });

    const list = await get<GroupListView>('/api/groups?sort=members');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 2, page: 1 });
    expect(list.body.items[0]).toMatchObject({
      title: '<b>لولوآباد</b>',
      members: 1,
      cityLevel: 1,
      bloodBank: '0',
    });
    expect((await get('/api/groups?status=sleeping')).status).toBe(400);

    const d = await get<GroupDetailView>(`/api/groups/${groupId}`);
    expect(d.status).toBe(200);
    expect(d.body.group.title).toBe('<b>لولوآباد</b>');
    expect(d.body.city).toMatchObject({ level: 1, population: { active: 1 } });
    expect(d.body.city.curses.map((c) => c.name)).toEqual(['شتاب شکار', 'پژواک لولو']);
    expect(d.body.leaderboard[0]).toMatchObject({
      rank: 1,
      displayName: 'سارا',
      levelName: 'روح',
      points: '100',
    });
    expect((await get('/api/groups/99999')).status).toBe(404);
  });

  it('are disabled and enabled with a reason, audited, and report a no-op', async () => {
    const { groupId } = await newGroupWithChat(game);
    expect(
      (await post(`/api/groups/${groupId}/disable`, { disabled: true, reason: '' })).status,
    ).toBe(400);
    expect(
      (await post(`/api/groups/${groupId}/disable`, { disabled: true, reason: 'اسپم' })).status,
    ).toBe(200);
    const again = await post<ApiErrorBody>(`/api/groups/${groupId}/disable`, {
      disabled: true,
      reason: 'اسپم',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('این گروه از قبل غیرفعال است.');
    const d = await get<GroupDetailView>(`/api/groups/${groupId}`);
    expect(d.body.group).toMatchObject({ disabledReason: 'اسپم' });
    expect((await get<GroupListView>('/api/groups?status=disabled')).body.total).toBe(1);
    expect(
      (await post(`/api/groups/${groupId}/disable`, { disabled: false, reason: 'حل شد' })).status,
    ).toBe(200);
    const audit = await game.ctx.db.select().from(auditLogs);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['group.disable', 'group.enable']),
    );
  });
});

describe('migration conflicts', () => {
  it('are listed and marked as reviewed with a note', async () => {
    const a = await newGroupWithChat(game, 'الف');
    const busy = await newGroupWithChat(game, 'پر');
    await claimLolo(game.ctx, { userId: await newPlayer(game), groupId: busy.groupId });
    await migrateGroupChat(game.ctx, {
      platform: 'telegram',
      fromChatId: a.chatId,
      toChatId: busy.chatId,
    });

    const o = await get<MigrationOverviewView>('/api/groups/migrations');
    expect(o.status).toBe(200);
    expect(o.body.openConflicts).toHaveLength(1);
    const id = o.body.openConflicts[0]!.id;
    expect((await post(`/api/groups/migrations/${id}/review`, { note: '' })).status).toBe(400);
    expect((await post(`/api/groups/migrations/${id}/review`, { note: 'جدا بمانند' })).status).toBe(
      200,
    );
    expect((await post(`/api/groups/migrations/${id}/review`, { note: 'دوباره' })).status).toBe(
      404,
    );
    const after = await get<MigrationOverviewView>('/api/groups/migrations');
    expect(after.body.openConflicts).toEqual([]);
    expect(after.body.recent[0]!.review).toMatchObject({
      adminUsername: 'helper',
      note: 'جدا بمانند',
    });
  });
});
