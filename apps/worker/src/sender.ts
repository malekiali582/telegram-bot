import type { Platform } from '@lulu/database';
import type { DomainContext } from '@lulu/domain';
import { addEncounterMessageRef, attachEncounterMessage } from '@lulu/domain';
import type { PlatformAdapter, SentMessageRef } from '@lulu/platform';
import { PlatformSendError } from '@lulu/platform';
import type { ClaimedMessage, Logger, OnSentHook } from '@lulu/runtime';
import {
  SendRateLimiter,
  TELEGRAM_RATE_LIMITS,
  claimDue,
  deferClaimed,
  holdLease,
  markFailed,
  markSent,
  releaseLease,
} from '@lulu/runtime';

export interface SenderDeps {
  ctx: DomainContext;
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  log: Logger;
  /** Rate limiter; `null` disables limiting (tests with a frozen clock). */
  limiter?: SendRateLimiter | null;
}

export interface DrainStats {
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
}

/** Telegram group and supergroup chat ids are negative. */
const isTelegramGroup = (chatId: string) => chatId.startsWith('-');

/**
 * Delivers outbox rows through the platform adapters, respecting rate limits and
 * `retry_after`. Transient failures back off; permanent ones are marked dead. A row is
 * marked sent before its follow-up hook runs, so a hook problem can never cause the
 * same message to be sent twice.
 */
export class OutboxSender {
  private readonly deps: SenderDeps;
  private readonly limiter: SendRateLimiter | null;

  constructor(deps: SenderDeps) {
    this.deps = deps;
    this.limiter =
      deps.limiter === undefined
        ? new SendRateLimiter(TELEGRAM_RATE_LIMITS, isTelegramGroup)
        : deps.limiter;
  }

  async drainOnce(limit = 20): Promise<DrainStats> {
    const now = this.deps.ctx.clock.now();
    const batch = await claimDue(this.deps.ctx.db, now, { limit });
    const stats: DrainStats = { claimed: batch.length, sent: 0, failed: 0, deferred: 0 };
    for (const message of batch) await this.deliver(message, stats);
    return stats;
  }

  private async deliver(m: ClaimedMessage, stats: DrainStats): Promise<void> {
    const { db } = this.deps.ctx;
    const now = this.deps.ctx.clock.now();
    const adapter = this.deps.adapters[m.platform];
    if (!adapter) {
      await markFailed(db, {
        id: m.id,
        now,
        attempts: m.attempts,
        error: `no adapter for ${m.platform}`,
        kind: 'permanent',
      });
      stats.failed++;
      return;
    }

    const chatId = m.item.kind === 'answer_button' ? null : m.item.payload.platformChatId;
    const wait = this.limiter ? this.limiter.tryReserve(chatId, now.getTime()) : 0;
    if (wait > 0) {
      await deferClaimed(db, m.id, new Date(now.getTime() + wait));
      stats.deferred++;
      return;
    }

    let ref: SentMessageRef | null = null;
    try {
      switch (m.item.kind) {
        case 'send':
          ref = await adapter.send(m.item.payload);
          break;
        case 'edit':
          await adapter.edit(
            { platformChatId: m.item.payload.platformChatId, messageId: m.item.payload.messageId },
            m.item.payload.edit,
          );
          break;
        case 'answer_button': {
          const { callbackId, text, alert } = m.item.payload;
          await adapter.answerButton(
            callbackId,
            text ? { text, ...(alert ? { alert } : {}) } : undefined,
          );
          break;
        }
      }
    } catch (err) {
      const e =
        err instanceof PlatformSendError ? err : new PlatformSendError('transient', String(err));
      const outcome = await markFailed(db, {
        id: m.id,
        now,
        attempts: m.attempts,
        error: e.message,
        kind: e.kind,
        ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
      });
      this.deps.log.warn('send failed', {
        outboxId: m.id,
        kind: e.kind,
        outcome,
        attempts: m.attempts,
      });
      stats.failed++;
      return;
    }

    await markSent(db, m.id, now, ref);
    stats.sent++;
    if (ref && m.onSent) {
      try {
        await this.runHook(m.onSent, m.platform, ref);
      } catch (err) {
        this.deps.log.error('on-sent hook failed', {
          outboxId: m.id,
          hook: m.onSent.type,
          error: err,
        });
      }
    }
  }

  private async runHook(hook: OnSentHook, platform: Platform, ref: SentMessageRef): Promise<void> {
    switch (hook.type) {
      case 'ghost_encounter':
        await attachEncounterMessage(this.deps.ctx, {
          encounterId: hook.encounterId,
          messageId: ref.messageId,
        });
        return;
      case 'ghost_repost':
        await addEncounterMessageRef(this.deps.ctx, {
          encounterId: hook.encounterId,
          platform,
          chatId: ref.platformChatId,
          messageId: ref.messageId,
        });
        return;
    }
  }
}

export const SENDER_LEASE = 'outbox-sender';

/**
 * Keeps one sender active across all processes (job lease), draining on every NOTIFY
 * and at least every `intervalMs`.
 */
export function startSenderLoop(
  sender: OutboxSender,
  options: { ctx: DomainContext; ownerId: string; intervalMs: number; log: Logger },
): { wake(): void; stop(): Promise<void> } {
  let stopped = false;
  let wakeUp: (() => void) | undefined;
  const sleep = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalMs);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        const holder = await holdLease(
          options.ctx.db,
          SENDER_LEASE,
          options.ownerId,
          options.ctx.clock.now(),
          30_000,
        );
        if (holder) {
          let stats: DrainStats;
          do stats = await sender.drainOnce();
          while (!stopped && stats.claimed > 0 && stats.deferred < stats.claimed);
        }
      } catch (err) {
        options.log.error('outbox loop error', { error: err });
      }
      if (!stopped) await sleep();
    }
    await releaseLease(options.ctx.db, SENDER_LEASE, options.ownerId).catch(() => {});
  })();

  return {
    wake: () => wakeUp?.(),
    async stop() {
      stopped = true;
      wakeUp?.();
      await loop;
    },
  };
}
