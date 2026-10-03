import { randomBytes } from 'node:crypto';
import type { Executor, Platform } from '@lulu/database';
import { pendingConfirmations, queryRows } from '@lulu/database';
import type { DomainContext } from '@lulu/domain';
import type { Button } from '@lulu/platform';
import { eq, sql } from 'drizzle-orm';

/**
 * Every button is backed by a row in `pending_confirmations`: a random token bound
 * to its owner, chat, action and fixed parameters, short-lived and single-use. The
 * button payload is only `b:<token>`, so it cannot be forged into another action,
 * amount or recipient. Using one button of a message invalidates its siblings.
 */

export interface ButtonSpec {
  label: string;
  action: string;
  params?: Record<string, unknown>;
}

const DATA = /^b:([A-Za-z0-9_-]{22})$/;

export function tokenFromData(data: string): string | null {
  return DATA.exec(data)?.[1] ?? null;
}

export async function makeButtons(
  ctx: DomainContext,
  owner: { userId: number; groupId: number | null; platform: Platform; chatId: string },
  rows: ButtonSpec[][],
): Promise<Button[][]> {
  const now = ctx.clock.now();
  const { config } = await ctx.config.effectiveAt(ctx.db, now);
  const expiresAt = new Date(now.getTime() + config.confirmations.ttlSeconds * 1000);
  const batch = randomBytes(8).toString('hex');
  const result: Button[][] = [];
  for (const row of rows) {
    const buttons: Button[] = [];
    for (const spec of row) {
      const token = randomBytes(16).toString('base64url');
      await ctx.db.insert(pendingConfirmations).values({
        token,
        userId: owner.userId,
        action: spec.action,
        params: { ...(spec.params ?? {}), batch },
        groupId: owner.groupId,
        platform: owner.platform,
        chatId: owner.chatId,
        createdAt: now,
        expiresAt,
      });
      buttons.push({ kind: 'callback', label: spec.label, data: `b:${token}` });
    }
    result.push(buttons);
  }
  return result;
}

/** Confirm/cancel pair for an operation. */
export function confirmRow(
  op: string,
  params: Record<string, unknown>,
  labels: { confirm: string; cancel: string },
): ButtonSpec[][] {
  return [
    [
      { label: labels.confirm, action: 'confirm', params: { op, ...params } },
      { label: labels.cancel, action: 'cancel' },
    ],
  ];
}

export type PendingButton = typeof pendingConfirmations.$inferSelect;

export type ClaimResult =
  | { status: 'ok'; button: PendingButton }
  | { status: 'invalid' | 'not_yours' | 'used' | 'expired' };

/** Reads a button without locking (to decide whether a live role check is needed). */
export async function peekButton(ex: Executor, token: string): Promise<PendingButton | undefined> {
  const [row] = await ex
    .select()
    .from(pendingConfirmations)
    .where(eq(pendingConfirmations.token, token));
  return row;
}

/**
 * Validates and consumes a clicked button inside the update transaction. A click by
 * someone else does not consume it; any valid click consumes the whole message's set.
 */
export async function claimButton(
  tx: Executor,
  input: {
    token: string;
    userId: number | undefined;
    platform: Platform;
    chatId: string;
    now: Date;
  },
): Promise<ClaimResult> {
  const [row] = await tx
    .select()
    .from(pendingConfirmations)
    .where(eq(pendingConfirmations.token, input.token))
    .for('update');
  if (!row || row.platform !== input.platform || row.chatId !== input.chatId)
    return { status: 'invalid' };
  if (input.userId === undefined || row.userId !== input.userId) return { status: 'not_yours' };
  if (row.usedAt) return { status: 'used' };
  if (input.now.getTime() >= row.expiresAt.getTime()) return { status: 'expired' };

  const batch = typeof row.params.batch === 'string' ? row.params.batch : null;
  await queryRows(
    tx,
    batch
      ? sql`UPDATE pending_confirmations SET used_at = ${input.now.toISOString()}::timestamptz
            WHERE user_id = ${row.userId} AND params->>'batch' = ${batch} AND used_at IS NULL
            RETURNING token`
      : sql`UPDATE pending_confirmations SET used_at = ${input.now.toISOString()}::timestamptz
            WHERE token = ${row.token} RETURNING token`,
  );
  return { status: 'ok', button: row };
}
