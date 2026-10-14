import { auditLogs, ghostBatches } from '@lulu/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelGhostBatch,
  ghostBatchDetail,
  ghostOverview,
  importPanelGhostBatch,
} from './admin-ghosts.ts';
import { activateDueBatches, importGhostBatch } from './ghost-batches.ts';
import { searchGhost } from './ghosts.ts';
import type { TestGame } from './testing.ts';
import {
  createAdminUser,
  createTestGame,
  ghostBatchInput,
  newGroup,
  newPlayer,
  tehranTime,
} from './testing.ts';

let game: TestGame;
let admin: number;
const TODAY = '2026-10-14';
beforeEach(async () => {
  game = await createTestGame();
  game.clock.set(tehranTime(TODAY, '10:00:00'));
  admin = await createAdminUser(game);
});
afterEach(async () => {
  await game.close();
});

const texts = (tag: string) => [1, 2, 3, 4, 5].map((n) => `متن ${n} ${tag}`);
const add = (activeDate: string, list = texts(activeDate)) =>
  importPanelGhostBatch(game.ctx, { activeDate, texts: list, adminUserId: admin, requestId: 'r1' });

describe('panel ghost form', () => {
  it('refuses an incomplete form as a whole, text by text, and never touches the live batch', async () => {
    await importGhostBatch(game.ctx, ghostBatchInput(TODAY, 'live'), { source: 'file' });
    const long = 'ا'.repeat(4000);
    const result = await add('2026-10-15', ['یک', '  ', long, 'یک', 'پنج']);
    expect(result).toEqual({
      status: 'invalid',
      activeDate: null,
      texts: [
        null,
        { code: 'empty' },
        { code: 'too_long', length: 4000, limit: 3500, decidedBy: 'telegram' },
        { code: 'duplicate', of: 0 },
        null,
      ],
      wrongCount: null,
    });
    expect(await add('2026-10-15', texts('x').slice(0, 4))).toMatchObject({
      status: 'invalid',
      wrongCount: { expected: 5, got: 4 },
    });
    expect(await add('2026-10-13')).toMatchObject({ status: 'invalid', activeDate: 'in_past' });
    expect(await add('2026-02-30')).toMatchObject({ status: 'invalid', activeDate: 'invalid' });

    const rows = await game.ctx.db.select().from(ghostBatches);
    expect(rows.map((r) => r.batchKey)).toEqual(['live']);
  });

  it('adds a batch once, audited; a batch for today goes live at once', async () => {
    const later = await add('2026-10-16');
    expect(later).toMatchObject({ status: 'imported', activeDate: '2026-10-16', live: false });
    expect(await add('2026-10-16')).toMatchObject({ status: 'already_imported' });
    expect(await add('2026-10-16', texts('دیگر'))).toEqual({
      status: 'conflict',
      reason: 'date_taken',
    });

    const now = await add(TODAY);
    expect(now).toMatchObject({ status: 'imported', live: true });
    const overview = await ghostOverview(game.ctx);
    expect(overview.active).toMatchObject({ activeDate: TODAY, source: 'panel' });
    expect(overview.active?.importedBy).toMatch(/^admin\d+$/);

    const audit = await game.ctx.db.select().from(auditLogs);
    expect(audit.map((a) => [a.action, a.adminUserId, a.requestId])).toEqual([
      ['ghost.import', admin, 'r1'],
      ['ghost.import', admin, 'r1'],
    ]);
  });

  it('cancels only a waiting batch, with a reason, so the night can be filled again', async () => {
    const first = await add('2026-10-15');
    if (first.status !== 'imported') throw new Error(first.status);
    const cancel = (id: number, reason = 'اشتباه تایپی') =>
      cancelGhostBatch(game.ctx, { id, reason, adminUserId: admin });
    expect(await cancel(first.id, '  ')).toEqual({ status: 'reason_required' });
    expect(await cancel(9999)).toEqual({ status: 'not_found' });
    expect(await cancel(first.id)).toEqual({ status: 'ok' });
    expect(await cancel(first.id)).toEqual({ status: 'not_scheduled' });

    // The same texts again get a fresh id instead of «already added».
    const again = await add('2026-10-15');
    expect(again).toMatchObject({ status: 'imported' });
    if (again.status !== 'imported') return;
    expect(again.batchId).toBe(`${first.batchId}-2`);

    const detail = await ghostBatchDetail(game.ctx, first.id);
    expect(detail?.batch.status).toBe('cancelled');
    expect(detail?.cancellation).toMatchObject({ reason: 'اشتباه تایپی' });
    expect(detail?.cancellation?.by).toMatch(/^admin\d+$/);

    const live = await add(TODAY);
    if (live.status !== 'imported') throw new Error(live.status);
    expect(await cancel(live.id)).toEqual({ status: 'not_scheduled' });
  });
});

describe('ghost content overview', () => {
  it('lists live, waiting and past batches and the days ahead with nothing waiting', async () => {
    let overview = await ghostOverview(game.ctx);
    expect(overview).toMatchObject({
      today: TODAY,
      warning: 'no_active_batch',
      lookaheadDays: 3,
      missingDates: ['2026-10-15', '2026-10-16', '2026-10-17'],
      limits: { batchSize: 5, maxStoryLength: 3500, decidedBy: 'telegram' },
      active: null,
    });

    game.clock.set(tehranTime('2026-10-13', '10:00:00'));
    await add('2026-10-13'); // live at once
    await add(TODAY);
    await add('2026-10-16');
    await importGhostBatch(game.ctx, ghostBatchInput('2026-10-15', 'typo'), { source: 'file' });
    const [typo] = (await ghostOverview(game.ctx)).upcoming.filter((b) => b.batchId === 'typo');
    await cancelGhostBatch(game.ctx, { id: typo!.id, reason: 'غلط', adminUserId: admin });
    game.clock.set(tehranTime(TODAY, '00:00:30'));
    expect((await ghostOverview(game.ctx)).warning).toBe('stale_batch'); // worker not run yet
    await activateDueBatches(game.ctx);

    overview = await ghostOverview(game.ctx);
    expect(overview.warning).toBeNull();
    expect(overview.active?.activeDate).toBe(TODAY);
    expect(overview.upcoming.map((b) => b.activeDate)).toEqual(['2026-10-16']);
    expect(overview.missingDates).toEqual(['2026-10-15', '2026-10-17']);
    expect(overview.past.map((b) => [b.batchId, b.status])).toEqual([
      ['typo', 'cancelled'],
      [expect.stringMatching(/^panel-2026-10-13-/), 'retired'],
    ]);
    expect(overview.pastTotal).toBe(2);
  });

  it('shows every text of a batch with how often its ghost was found and heard', async () => {
    const live = await add(TODAY);
    if (live.status !== 'imported') throw new Error(live.status);
    game.rng.fallback = 'min';
    const group = await newGroup(game);
    const player = await newPlayer(game);
    const found = await searchGhost(game.ctx, {
      userId: player,
      groupId: group,
      platform: 'telegram',
      chatId: 'chat',
    });
    expect(found.status).toBe('found');

    const detail = await ghostBatchDetail(game.ctx, live.id);
    expect(detail?.stories).toHaveLength(5);
    expect(detail?.stories.map((s) => s.text)).toEqual(texts(TODAY));
    expect(detail?.stories.reduce((n, s) => n + s.encounters, 0)).toBe(1);
    expect(detail?.batch).toMatchObject({ encounters: 1, heard: 0, status: 'active' });
    expect(detail?.cancellation).toBeNull();
    expect(await ghostBatchDetail(game.ctx, 9999)).toBeNull();
  });
});
