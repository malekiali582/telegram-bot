import { auditLogs, outbox } from '@lulu/database';
import { botRemovedFromGroup, setGroupDisabled } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame, newGroupWithChat } from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnnouncementDetailView,
  AnnouncementListView,
  AnnouncementRecipientsView,
  ApiErrorBody,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let helper: LoggedIn;
let adminId: number;

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  api = await createTestApi(game);
  adminId = await addAdmin(game, 'helper', 'admin');
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
const post = async <T>(url: string, payload: object = {}) => {
  const r = await api.app.inject({ method: 'POST', url, headers: helper.writeHeaders, payload });
  return { status: r.statusCode, body: r.json<T>() };
};
const ALL = { kind: 'all_groups' } as const;

async function threeGroups() {
  const a = await newGroupWithChat(game, 'آبادی یک');
  const b = await newGroupWithChat(game, 'آبادی دو');
  const off = await newGroupWithChat(game, 'خاموش');
  const gone = await newGroupWithChat(game, 'بی‌ربات');
  await setGroupDisabled(game.ctx, {
    groupId: off.groupId,
    disabled: true,
    reason: 'آزمایش',
    adminUserId: adminId,
  });
  await botRemovedFromGroup(game.ctx, { platform: 'telegram', platformChatId: gone.chatId });
  return { a, b, off, gone };
}

describe('announcement recipients', () => {
  it('counts groups the bot is in, leaving out disabled ones only for «every group»', async () => {
    const { off, gone } = await threeGroups();
    const all = await get<AnnouncementRecipientsView>('/api/announcements/recipients');
    expect(all.body).toEqual({
      count: 2,
      byPlatform: [{ platform: 'telegram', count: 2 }],
      sample: ['آبادی یک', 'آبادی دو'],
      skipped: { disabled: 1, botRemoved: 1, otherPlatform: 0 },
      maxLength: 4096,
    });
    const one = await get<AnnouncementRecipientsView>(
      `/api/announcements/recipients?groupId=${off.groupId}`,
    );
    expect(one.body).toMatchObject({ count: 1, sample: ['خاموش'] });
    const removed = await get<AnnouncementRecipientsView>(
      `/api/announcements/recipients?groupId=${gone.groupId}`,
    );
    expect(removed.body).toMatchObject({ count: 0, skipped: { botRemoved: 1 } });
    expect((await get('/api/announcements/recipients?groupId=9999')).status).toBe(404);
  });
});

describe('sending an announcement', () => {
  it('queues one plain-text outbox message per group, spread over time, and audits it', async () => {
    const { a, b } = await threeGroups();
    const text = '  <b>به‌روزرسانی</b> امشب ساعت ۲۲  ';
    const sent = await post<{ id: number; recipients: number }>('/api/announcements', {
      target: ALL,
      text,
      silent: true,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.recipients).toBe(2);

    const rows = await game.ctx.db
      .select()
      .from(outbox)
      .where(eq(outbox.announcementId, sent.body.id))
      .orderBy(outbox.id);
    expect(rows.map((r) => r.payload)).toEqual([
      { platformChatId: a.chatId, text: text.trim(), format: 'plain', silent: true },
      { platformChatId: b.chatId, text: text.trim(), format: 'plain', silent: true },
    ]);
    expect(rows.every((r) => r.status === 'pending' && r.kind === 'send')).toBe(true);

    const audit = await game.ctx.db.select().from(auditLogs);
    expect(audit.find((x) => x.action === 'announcement.send')).toMatchObject({
      adminUserId: adminId,
      details: { announcementId: sent.body.id, recipients: 2, silent: true },
    });

    const list = await get<AnnouncementListView>('/api/announcements');
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      text: text.trim(),
      target: 'all_groups',
      createdBy: 'helper',
      silent: true,
      counts: { total: 2, pending: 2, sent: 0, failed: 0, cancelled: 0 },
    });
  });

  it('refuses empty, too long, unknown-group and recipient-less announcements in Persian', async () => {
    const { gone } = await threeGroups();
    const send = (body: object) =>
      post<ApiErrorBody>('/api/announcements', {
        target: ALL,
        text: 'سلام',
        silent: false,
        ...body,
      });
    expect((await send({ text: '   ' })).body.error.message).toBe('متن اطلاعیه خالی است.');
    expect((await send({ text: 'ا'.repeat(4097) })).body.error.message).toBe(
      'متن ۴٬۰۹۷ نویسه است؛ حداکثر ۴٬۰۹۶ نویسه.',
    );
    expect((await send({ target: { kind: 'group', groupId: 9999 } })).status).toBe(404);
    const none = await send({ target: { kind: 'group', groupId: gone.groupId } });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toContain('هیچ گروهی');
    expect((await send({ target: { kind: 'everyone' } })).status).toBe(400);
    expect(await game.ctx.db.select().from(outbox)).toEqual([]);
  });

  it('cancels what is still waiting and retries what failed', async () => {
    await threeGroups();
    const { body } = await post<{ id: number }>('/api/announcements', {
      target: ALL,
      text: 'سلام',
      silent: false,
    });
    const [first] = await game.ctx.db
      .select()
      .from(outbox)
      .where(eq(outbox.announcementId, body.id))
      .orderBy(outbox.id);
    await game.ctx.db
      .update(outbox)
      .set({ status: 'dead', lastError: 'Forbidden: bot was kicked' })
      .where(eq(outbox.id, first!.id));

    expect((await post(`/api/announcements/${body.id}/cancel`)).body).toEqual({ cancelled: 1 });
    const again = await post<ApiErrorBody>(`/api/announcements/${body.id}/cancel`);
    expect(again.status).toBe(409);

    const detail = await get<AnnouncementDetailView>(`/api/announcements/${body.id}`);
    expect(detail.body).toMatchObject({
      cancelledBy: 'helper',
      counts: { total: 2, pending: 0, failed: 1, cancelled: 1 },
    });
    expect(detail.body.deliveries.map((d) => [d.title, d.status, d.lastError])).toEqual([
      ['آبادی یک', 'dead', 'Forbidden: bot was kicked'],
      ['آبادی دو', 'cancelled', null],
    ]);

    expect((await post(`/api/announcements/${body.id}/retry`)).body).toEqual({ retried: 1 });
    expect((await post(`/api/announcements/${body.id}/retry`)).status).toBe(409);
    const after = await get<AnnouncementDetailView>(`/api/announcements/${body.id}`);
    expect(after.body.counts).toMatchObject({ pending: 1, failed: 0 });
    expect((await get('/api/announcements/9999')).status).toBe(404);
    expect((await post('/api/announcements/9999/cancel')).status).toBe(404);

    const actions = (await game.ctx.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['announcement.send', 'announcement.cancel', 'announcement.retry']),
    );
  });
});
