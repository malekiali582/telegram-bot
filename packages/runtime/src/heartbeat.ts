import type { Database } from '@lulu/database';
import { serviceHeartbeats } from '@lulu/database';
import { and, eq, lt } from 'drizzle-orm';
import { newOwnerId } from './jobs.ts';
import type { Logger } from './logger.ts';

/**
 * Liveness reports for the admin panel. Each bot and worker process upserts its own row
 * every 30 seconds and marks it stopped on a clean shutdown. A row that stops being
 * refreshed without `stopped_at` means the process died or hangs.
 */

export type ServiceName = 'bot' | 'worker';

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Silent this long (three missed beats) = not responding. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;

export interface Heartbeat {
  readonly instance: string;
  stop(): Promise<void>;
}

export async function startHeartbeat(
  db: Database,
  options: {
    service: ServiceName;
    log: Logger;
    details?: Record<string, unknown>;
    intervalMs?: number;
    now?: () => Date;
  },
): Promise<Heartbeat> {
  const now = options.now ?? (() => new Date());
  const instance = newOwnerId();
  const startedAt = now();
  const details = options.details ?? {};

  const beat = async () => {
    const at = now();
    await db
      .insert(serviceHeartbeats)
      .values({ service: options.service, instance, startedAt, lastSeenAt: at, details })
      .onConflictDoUpdate({
        target: [serviceHeartbeats.service, serviceHeartbeats.instance],
        set: { lastSeenAt: at },
      });
  };

  await beat();
  // Rows of processes gone for a week only clutter the panel.
  await db
    .delete(serviceHeartbeats)
    .where(lt(serviceHeartbeats.lastSeenAt, new Date(startedAt.getTime() - 7 * 86_400_000)));

  const timer = setInterval(() => {
    beat().catch((err: unknown) => options.log.warn('heartbeat failed', { error: err }));
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    instance,
    async stop() {
      clearInterval(timer);
      await db
        .update(serviceHeartbeats)
        .set({ stoppedAt: now(), lastSeenAt: now() })
        .where(
          and(
            eq(serviceHeartbeats.service, options.service),
            eq(serviceHeartbeats.instance, instance),
          ),
        )
        .catch(() => {});
    },
  };
}
