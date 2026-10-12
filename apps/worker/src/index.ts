import type { Platform } from '@lulu/database';
import type { DomainContext } from '@lulu/domain';
import type { PlatformAdapter } from '@lulu/platform';
import type { Logger } from '@lulu/runtime';
import { JobScheduler, OUTBOX_CHANNEL, newOwnerId, startHeartbeat } from '@lulu/runtime';
import { workerJobs } from './jobs.ts';
import { listenForNotifications } from './listen.ts';
import { OutboxSender, startSenderLoop } from './sender.ts';

export * from './sender.ts';
export * from './jobs.ts';
export * from './listen.ts';

export interface WorkerOptions {
  ctx: DomainContext;
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  log: Logger;
  /** PostgreSQL URL for LISTEN; without it the sender only polls. */
  listenUrl?: string;
  outboxIntervalMs: number;
  /** How often due jobs are checked. */
  tickMs?: number;
}

/**
 * Starts the outbox sender, the job scheduler and the worker heartbeat; used by the
 * worker app and both development modes.
 */
export async function startWorker(options: WorkerOptions): Promise<{ stop(): Promise<void> }> {
  const ownerId = newOwnerId();
  const log = options.log.child({ component: 'worker' });
  const sender = new OutboxSender({ ctx: options.ctx, adapters: options.adapters, log });
  const senderLoop = startSenderLoop(sender, {
    ctx: options.ctx,
    ownerId,
    intervalMs: options.outboxIntervalMs,
    log,
  });
  const listener = options.listenUrl
    ? listenForNotifications(options.listenUrl, OUTBOX_CHANNEL, () => senderLoop.wake(), log)
    : undefined;

  const scheduler = new JobScheduler(
    options.ctx.db,
    workerJobs(options.ctx),
    log,
    () => options.ctx.clock.now(),
    ownerId,
  );
  await scheduler.ensureJobs();
  const heartbeat = await startHeartbeat(options.ctx.db, {
    service: 'worker',
    log,
    details: { platforms: Object.keys(options.adapters) },
  });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const ran = await scheduler.tick();
      if (ran.length) log.debug('jobs ran', { jobs: ran });
    } catch (err) {
      log.error('scheduler tick failed', { error: err });
    }
    if (!stopped) timer = setTimeout(() => void tick(), options.tickMs ?? 5_000);
  };
  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await listener?.close();
      await senderLoop.stop();
      await heartbeat.stop();
    },
  };
}
