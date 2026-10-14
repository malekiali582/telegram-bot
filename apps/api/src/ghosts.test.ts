import { auditLogs } from '@lulu/database';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame } from '@lulu/domain/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AddGhostBatchView,
  ApiErrorBody,
  GhostBatchDetailView,
  GhostOverviewView,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let helper: LoggedIn;

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z'); // 11:30 in Tehran
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
const texts = (tag: string) => [1, 2, 3, 4, 5].map((n) => `<b>متن ${n}</b> ${tag}`);

describe('ghost content', () => {
  it('warns when there is no content and explains a refused form in Persian', async () => {
    const empty = await get<GhostOverviewView>('/api/ghosts');
    expect(empty.body).toMatchObject({
      today: '2026-10-14',
      warning: 'no_active_batch',
      missingDates: ['2026-10-15', '2026-10-16', '2026-10-17'],
      limits: { batchSize: 5, maxStoryLength: 3500, decidedBy: 'telegram' },
    });

    const bad = await post<AddGhostBatchView>('/api/ghosts', {
      activeDate: '2026-10-13',
      texts: ['یک', '', 'ا'.repeat(3501), 'یک'],
    });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({
      status: 'invalid',
      activeDate: 'تاریخ گذشته است؛ بسته فقط برای امروز یا روزهای بعد پذیرفته می‌شود.',
      texts: [
        null,
        'این متن خالی است.',
        '۳٬۵۰۱ نویسه است؛ حداکثر ۳٬۵۰۰ نویسه (محدودیت پیام تلگرام).',
        'همان متن ۱ است.',
      ],
      form: 'بسته باید دقیقاً ۵ متن داشته باشد.',
    });
    expect((await post('/api/ghosts', { activeDate: 1, texts: [] })).status).toBe(400);
    expect((await get<GhostOverviewView>('/api/ghosts')).body.upcoming).toEqual([]);
  });

  it('adds batches, shows their texts as plain data, and cancels a waiting one', async () => {
    const live = await post<AddGhostBatchView>('/api/ghosts', {
      activeDate: '2026-10-14',
      texts: texts('امروز'),
    });
    expect(live.body).toMatchObject({ status: 'imported', live: true });
    const next = await post<AddGhostBatchView>('/api/ghosts', {
      activeDate: '2026-10-15',
      texts: texts('فردا'),
    });
    expect(next.body).toMatchObject({ status: 'imported', live: false });
    const again = await post<AddGhostBatchView>('/api/ghosts', {
      activeDate: '2026-10-15',
      texts: texts('فردا'),
    });
    expect(again.body.status).toBe('already_imported');
    const taken = await post<ApiErrorBody>('/api/ghosts', {
      activeDate: '2026-10-15',
      texts: texts('دیگر'),
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toContain('اول آن بسته را لغو کنید');

    const overview = (await get<GhostOverviewView>('/api/ghosts')).body;
    expect(overview.warning).toBeNull();
    expect(overview.active).toMatchObject({ activeDate: '2026-10-14', importedBy: 'helper' });
    expect(overview.upcoming.map((b) => b.activeDate)).toEqual(['2026-10-15']);
    expect(overview.missingDates).toEqual(['2026-10-16', '2026-10-17']);

    if (live.body.status !== 'imported' || next.body.status !== 'imported') return;
    const detail = await get<GhostBatchDetailView>(`/api/ghosts/${live.body.id}`);
    expect(detail.body.stories.map((s) => s.text)).toEqual(texts('امروز'));
    expect((await get(`/api/ghosts/9999`)).status).toBe(404);

    const url = `/api/ghosts/${next.body.id}/cancel`;
    expect((await post(url, { reason: ' ' })).status).toBe(400);
    expect((await post(url, { reason: 'غلط تایپی' })).status).toBe(200);
    const cancelled = await get<GhostBatchDetailView>(`/api/ghosts/${next.body.id}`);
    expect(cancelled.body.cancellation).toMatchObject({ by: 'helper', reason: 'غلط تایپی' });
    const liveCancel = await post<ApiErrorBody>(`/api/ghosts/${live.body.id}/cancel`, {
      reason: 'نه',
    });
    expect(liveCancel.status).toBe(409);

    const actions = (await game.ctx.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions.filter((a) => a.startsWith('ghost.'))).toEqual([
      'ghost.import',
      'ghost.import',
      'ghost.cancel',
    ]);
  });
});
