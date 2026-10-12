import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import {
  configVersions,
  jobState,
  outbox,
  pendingConfirmations,
  processedUpdates,
} from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { openCemetery } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { TEST_START, cashOf, createTestGame, grantPoints, newPlayer } from '@lulu/domain/testing';
import { JobScheduler, silentLogger } from '@lulu/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { nextSettlementRun, workerJobs } from './jobs.ts';

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
      workerJobs(game.ctx),
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
    const cleanup = workerJobs(game.ctx).find((j) => j.name === 'cleanup')!;
    expect(await cleanup.run()).toEqual({ processedUpdates: 1, buttons: 1, outbox: 1 });
    // dead messages are kept for inspection
    expect((await game.ctx.db.select().from(outbox)).map((o) => o.status)).toContain('dead');
    game.clock.set(TEST_START);
  });

  it('settles idle accounts hourly, and right after every Tehran midnight', async () => {
    const tehran = (date: string, time: string) => new Date(`${date}T${time}+03:30`);
    expect(await nextSettlementRun(game.ctx, tehran('2026-10-12', '10:00:00'))).toEqual(
      tehran('2026-10-12', '11:00:00'),
    );
    expect(await nextSettlementRun(game.ctx, tehran('2026-10-12', '23:30:00'))).toEqual(
      tehran('2026-10-13', '00:00:05'),
    );
    // The interval is a suggested value in the game configuration.
    const config = structuredClone(DEFAULT_GAME_CONFIG);
    config.settlement.periodicIntervalMinutes = 15;
    await game.ctx.db
      .insert(configVersions)
      .values({ config, source: 'panel', effectiveFrom: tehran('2026-10-12', '09:00:00') });
    expect(await nextSettlementRun(game.ctx, tehran('2026-10-12', '10:00:00'))).toEqual(
      tehran('2026-10-12', '10:15:00'),
    );
  });

  it('stores the configured next run after the settlement job', async () => {
    const scheduler = new JobScheduler(
      game.ctx.db,
      workerJobs(game.ctx).filter((j) => j.name === 'settlement'),
      silentLogger,
      () => game.clock.now(),
      'test-worker-2',
    );
    await game.ctx.db
      .update(jobState)
      .set({ nextRunAt: game.clock.now() })
      .where(eq(jobState.name, 'settlement'));
    expect(await scheduler.tick()).toEqual(['settlement']);
    const [row] = await game.ctx.db.select().from(jobState).where(eq(jobState.name, 'settlement'));
    expect(row!.nextRunAt).toEqual(await nextSettlementRun(game.ctx, game.clock.now()));
    expect(row!.nextRunAt.getTime()).toBeGreaterThan(game.clock.now().getTime() + 60_000);
  });
});
