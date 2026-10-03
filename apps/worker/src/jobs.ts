import { queryRows } from '@lulu/database';
import type { DomainContext } from '@lulu/domain';
import { activateDueBatches, settleDuePlayers } from '@lulu/domain';
import type { JobDefinition } from '@lulu/runtime';
import { sql } from 'drizzle-orm';

/**
 * Periodic jobs. Each one is idempotent: running late, twice, or alongside player
 * actions changes nothing that should not change (see the domain services).
 */
export function workerJobs(
  ctx: DomainContext,
  options: { settleIntervalMs: number },
): JobDefinition[] {
  return [
    {
      // Cemetery income and midnight interest, even for players who are offline.
      name: 'settlement',
      intervalMs: options.settleIntervalMs,
      leaseMs: 10 * 60_000,
      async run() {
        let afterUserId: number | undefined;
        let settled = 0;
        const deadline = Date.now() + 5 * 60_000;
        for (;;) {
          const batch = await settleDuePlayers(ctx, {
            ...(afterUserId ? { afterUserId } : {}),
            limit: 200,
          });
          settled += batch.settled;
          if (batch.settled < 200 || batch.lastUserId === undefined || Date.now() > deadline) break;
          afterUserId = batch.lastUserId;
        }
        return { settled };
      },
    },
    {
      // Switches the nightly ghost batch at Tehran midnight (searches also do it lazily).
      name: 'ghost-activation',
      intervalMs: 30_000,
      async run() {
        const result = await activateDueBatches(ctx);
        return {
          activated: result.activated,
          retired: result.retired,
          cancelled: result.cancelled.length,
        };
      },
    },
    {
      // Housekeeping: bounded growth of dedupe, button and delivered-message tables.
      name: 'cleanup',
      intervalMs: 60 * 60_000,
      async run() {
        const now = ctx.clock.now().getTime();
        const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
        const count = async (query: ReturnType<typeof sql>) =>
          (await queryRows(ctx.db, query)).length;
        return {
          processedUpdates: await count(
            sql`DELETE FROM processed_updates WHERE processed_at < ${iso(7 * 86_400_000)}::timestamptz RETURNING 1`,
          ),
          buttons: await count(
            sql`DELETE FROM pending_confirmations WHERE expires_at < ${iso(86_400_000)}::timestamptz RETURNING 1`,
          ),
          outbox: await count(
            sql`DELETE FROM outbox WHERE status = 'sent' AND sent_at < ${iso(7 * 86_400_000)}::timestamptz RETURNING 1`,
          ),
        };
      },
    },
  ];
}
