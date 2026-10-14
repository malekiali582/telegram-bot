/**
 * Announcements from the panel (8.7), end to end through the worker's sender: messages
 * enter the queue at most 10 per second so game replies are not held up, `retry_after`
 * is honoured, failures can be retried, and the delivery record survives cleanup.
 */
import {
  ANNOUNCEMENT_ROWS_PER_SECOND,
  announcementDetail,
  retryAnnouncementFailures,
  sendAnnouncement,
} from '@lulu/api';
import { FakeAdapter } from '@lulu/bot/testing';
import { outbox } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import type { TestGame } from '@lulu/domain/testing';
import { createAdminUser, createTestGame, newGroupWithChat } from '@lulu/domain/testing';
import { silentLogger } from '@lulu/runtime';
import { OutboxSender, workerJobs } from '@lulu/worker';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let adapter: FakeAdapter;
let sender: OutboxSender;
let admin: number;

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  adapter = new FakeAdapter();
  sender = new OutboxSender({
    ctx: game.ctx,
    adapters: { telegram: adapter },
    log: silentLogger,
    limiter: null,
  });
  admin = await createAdminUser(game);
});
afterEach(async () => {
  await game.close();
});

const drain = async () => {
  for (let i = 0; i < 50; i++) if ((await sender.drainOnce()).claimed === 0) return;
};
const announce = async (text: string) => {
  const result = await sendAnnouncement(game.ctx.db, {
    platforms: game.ctx.platforms,
    target: { kind: 'all_groups' },
    text,
    silent: false,
    adminUserId: admin,
    now: game.clock.now(),
  });
  if (result.status !== 'ok') throw new Error(result.status);
  return result.id;
};

describe(`announcements through the sender (${testBackend()})`, () => {
  it('trickles into the queue so game messages are not held up', async () => {
    for (let i = 0; i < 25; i++) await newGroupWithChat(game, `گروه ${i}`);
    const id = await announce('اطلاعیه');
    await drain();
    expect(adapter.sent).toHaveLength(ANNOUNCEMENT_ROWS_PER_SECOND);
    game.clock.advance(1000);
    await drain();
    expect(adapter.sent).toHaveLength(20);
    game.clock.advance(1000);
    await drain();
    expect(adapter.sent).toHaveLength(25);
    expect(adapter.sent.every((m) => m.text === 'اطلاعیه' && m.format === 'plain')).toBe(true);
    expect((await announcementDetail(game.ctx.db, id))?.counts).toMatchObject({
      total: 25,
      sent: 25,
      pending: 0,
    });
  });

  it('waits for retry_after, records a permanent failure and sends it again on retry', async () => {
    await newGroupWithChat(game, 'یک');
    await newGroupWithChat(game, 'دو');
    const id = await announce('سلام');
    adapter.failNext('rate_limited', 7);
    await drain();
    expect(adapter.sent).toHaveLength(1); // the first waits 7 seconds
    game.clock.advance(6000);
    await drain();
    expect(adapter.sent).toHaveLength(1);
    game.clock.advance(1000);
    adapter.failNext('permanent');
    await drain();
    let detail = await announcementDetail(game.ctx.db, id);
    expect(detail?.counts).toMatchObject({ sent: 1, failed: 1 });
    expect(detail?.deliveries[0]).toMatchObject({ status: 'dead', lastError: 'fake permanent' });

    await retryAnnouncementFailures(game.ctx.db, {
      id,
      adminUserId: admin,
      now: game.clock.now(),
    });
    await drain();
    detail = await announcementDetail(game.ctx.db, id);
    expect(detail?.counts).toMatchObject({ sent: 2, failed: 0 });

    // A week later the housekeeping job deletes delivered game messages, not these.
    game.clock.advance(8 * 86_400_000);
    const cleanup = workerJobs(game.ctx).find((j) => j.name === 'cleanup')!;
    await cleanup.run();
    const kept = await game.ctx.db.select().from(outbox).where(eq(outbox.announcementId, id));
    expect(kept).toHaveLength(2);
  });
});
