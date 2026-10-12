import type { Database, Executor, Platform } from '@lulu/database';
import { outbox, queryRows } from '@lulu/database';
import type { MessageEdit, OutgoingMessage, SentMessageRef } from '@lulu/platform';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Transactional outbox. Messages are written in the same transaction as the game
 * result they report, so a crash or a failed send can never repeat or lose the money
 * movement. A NOTIFY in that transaction wakes the sender as soon as it commits.
 */

export const OUTBOX_CHANNEL = 'lulu_outbox';

/** The `job_state` row whose lease marks the single active outbox sender. */
export const SENDER_LEASE = 'outbox-sender';

/** Every payload carries `platformChatId` at the top so a group migration can re-address it. */
export type OutboxItem =
  | { kind: 'send'; payload: OutgoingMessage }
  | {
      kind: 'edit';
      payload: { platformChatId: string; messageId: string; edit: MessageEdit };
    }
  | {
      kind: 'answer_button';
      payload: { platformChatId: string; callbackId: string; text?: string; alert?: boolean };
    };

/** Follow-up after a successful send, run by the sender. */
export type OnSentHook =
  /** The ghost message itself: «شنیدم» must reply to it. */
  | { type: 'ghost_encounter'; encounterId: number }
  /** A re-post of an open ghost (after a supergroup migration). */
  | { type: 'ghost_repost'; encounterId: number };

export async function enqueue(
  ex: Executor,
  platform: Platform,
  item: OutboxItem,
  options: { onSent?: OnSentHook; dedupeKey?: string; notBefore?: Date } = {},
): Promise<number> {
  const [row] = await ex
    .insert(outbox)
    .values({
      platform,
      kind: item.kind,
      payload: item.payload,
      onSent: options.onSent ?? null,
      dedupeKey: options.dedupeKey ?? null,
      ...(options.notBefore ? { nextAttemptAt: options.notBefore } : {}),
    })
    .returning({ id: outbox.id });
  await ex.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
  return row!.id;
}

export interface ClaimedMessage {
  id: number;
  platform: Platform;
  item: OutboxItem;
  attempts: number;
  onSent: OnSentHook | null;
}

/**
 * Claims up to `limit` due rows by pushing their next attempt `leaseMs` ahead in one
 * short transaction (SKIP LOCKED, so concurrent senders get disjoint rows). Sending
 * happens outside any transaction; if the sender dies mid-send the lease expires and
 * the row is retried (at-least-once delivery).
 */
export async function claimDue(
  db: Database,
  now: Date,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<ClaimedMessage[]> {
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 60_000));
  const rows = await queryRows<{
    id: string | number;
    platform: Platform;
    kind: OutboxItem['kind'];
    payload: unknown;
    attempts: number;
    on_sent: OnSentHook | null;
  }>(
    db,
    sql`UPDATE outbox o SET next_attempt_at = ${leaseUntil.toISOString()}::timestamptz,
                            attempts = o.attempts + 1
        FROM (SELECT id FROM outbox
              WHERE status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
              ORDER BY next_attempt_at, id
              LIMIT ${options.limit ?? 20}
              FOR UPDATE SKIP LOCKED) due
        WHERE o.id = due.id
        RETURNING o.id, o.platform, o.kind, o.payload, o.attempts, o.on_sent`,
  );
  return rows
    .map((r) => ({
      id: Number(r.id),
      platform: r.platform,
      item: { kind: r.kind, payload: r.payload } as OutboxItem,
      attempts: r.attempts,
      onSent: r.on_sent,
    }))
    .sort((a, b) => a.id - b.id);
}

export async function markSent(
  db: Executor,
  id: number,
  now: Date,
  result: SentMessageRef | null,
): Promise<void> {
  await db
    .update(outbox)
    .set({ status: 'sent', sentAt: now, result, lastError: null })
    .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')));
}

/** Puts a claimed row back without counting an attempt (e.g. waiting for a rate limit). */
export async function deferClaimed(db: Executor, id: number, until: Date): Promise<void> {
  await db
    .update(outbox)
    .set({ nextAttemptAt: until, attempts: sql`greatest(${outbox.attempts} - 1, 0)` })
    .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')));
}

export const MAX_ATTEMPTS = 8;

/** 2 s, 4 s, 8 s … capped at 5 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(1, attempts));
}

export async function markFailed(
  db: Executor,
  input: {
    id: number;
    now: Date;
    attempts: number;
    error: string;
    kind: 'rate_limited' | 'transient' | 'permanent';
    retryAfterSeconds?: number;
  },
): Promise<'retry' | 'dead'> {
  const dead = input.kind === 'permanent' || input.attempts >= MAX_ATTEMPTS;
  const waitMs =
    input.kind === 'rate_limited'
      ? Math.max(1, input.retryAfterSeconds ?? 1) * 1000
      : backoffMs(input.attempts);
  await db
    .update(outbox)
    .set({
      status: dead ? 'dead' : 'pending',
      lastError: input.error.slice(0, 500),
      nextAttemptAt: new Date(input.now.getTime() + (dead ? 0 : waitMs)),
    })
    .where(and(eq(outbox.id, input.id), eq(outbox.status, 'pending')));
  return dead ? 'dead' : 'retry';
}
