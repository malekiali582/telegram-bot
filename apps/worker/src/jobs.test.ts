import { outbox, pendingConfirmations, processedUpdates } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { openCemetery } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { TEST_START, cashOf, createTestGame, grantPoints, newPlayer } from '@lulu/domain/testing';
import { JobScheduler, silentLogger } from '@lulu/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerJobs } from './jobs.ts';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});

describe(`worker jobs (${testBackend()})`, () => {
  it('settles offline cemeteries through the scheduled job, once per due run', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 1000);
    await openCemetery(game.ctx, { userId });
    const scheduler = new JobScheduler(
      game.ctx.db,
      workerJobs(game.ctx, { settleIntervalMs: 60_000 }),
      silentLogger,
      () => game.clock.now(),
      'test-worker',
    );
    await scheduler.ensureJobs();
    game.clock.advance(3_600_000);
    expect(await scheduler.tick()).toEqual(['settlement', 'ghost-activation', 'cleanup']);
    expect(await cashOf(game, userId)).toBe(5_000n); // 1 h × 50
    expect(await scheduler.tick()).toEqual([]); // nothing due yet
  });

  it('cleans up old dedupe rows, expired buttons and delivered messages only', async () => {
    const now = game.clock.now();
    const old = new Date(now.getTime() - 8 * 86_400_000);
    const userId = await newPlayer(game);
    await game.ctx.db.insert(processedUpdates).values([
      { platform: 'telegram', updateId: 'old', processedAt: old },
      { platform: 'telegram', updateId: 'new', processedAt: now },
    ]);
    await game.ctx.db.insert(pendingConfirmations).values({
      token: 'expired-token-0123456789',
      userId,
      action: 'cancel',
      platform: 'telegram',
      chatId: '-1',
      createdAt: old,
      expiresAt: new Date(old.getTime() + 120_000),
    });
    await game.ctx.db.insert(outbox).values([
      { platform: 'telegram', kind: 'send', payload: {}, status: 'sent', sentAt: old },
      { platform: 'telegram', kind: 'send', payload: {}, status: 'dead' },
    ]);
    const cleanup = workerJobs(game.ctx, { settleIntervalMs: 60_000 }).find(
      (j) => j.name === 'cleanup',
    )!;
    expect(await cleanup.run()).toEqual({ processedUpdates: 1, buttons: 1, outbox: 1 });
    // dead messages are kept for inspection
    expect((await game.ctx.db.select().from(outbox)).map((o) => o.status)).toContain('dead');
    game.clock.set(TEST_START);
  });
});
