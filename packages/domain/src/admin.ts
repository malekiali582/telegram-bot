import { auditLogs, inTransaction, users } from '@lulu/database';
import { eq } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findTransactionByKey, postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { beginPlayerAction } from './players.ts';

/**
 * Admin-panel operations on players. Every one requires a reason and writes an
 * append-only audit log entry in the same transaction as the change.
 */

const cleanReason = (reason: string) => reason.trim().slice(0, 500);

export type BanResult =
  | { status: 'ok' }
  | { status: 'unchanged' }
  | { status: 'not_found' }
  | { status: 'reason_required' };

/** Bans (or unbans) a player from the game: no actions, no leaderboard. Data is kept. */
export async function setPlayerBan(
  ctx: DomainContext,
  input: {
    userId: number;
    banned: boolean;
    reason: string;
    adminUserId: number;
    requestId?: string;
  },
): Promise<BanResult> {
  const reason = cleanReason(input.reason);
  if (reason === '') return { status: 'reason_required' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
    if (!user) return { status: 'not_found' as const };
    if ((user.bannedAt !== null) === input.banned) return { status: 'unchanged' as const };
    await tx
      .update(users)
      .set(
        input.banned
          ? { bannedAt: now, banReason: reason, updatedAt: now }
          : { bannedAt: null, banReason: null, updatedAt: now },
      )
      .where(eq(users.id, input.userId));
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: input.banned ? 'player.ban' : 'player.unban',
      targetType: 'user',
      targetId: String(input.userId),
      reason,
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return { status: 'ok' as const };
  });
}

export type AdjustmentResult =
  | { status: 'ok'; transactionId: number; balanceCenti: bigint }
  | { status: 'invalid_amount' }
  | { status: 'reason_required' }
  | { status: 'insufficient_funds'; balanceCenti: bigint }
  | { status: 'duplicate' };

/**
 * Corrects a balance with a compensating transaction against the admin adjustment
 * account. Past ledger rows are never edited or deleted. Treasury corrections settle
 * past midnights first, so they never change interest already earned.
 */
export async function adjustBalance(
  ctx: DomainContext,
  input: {
    userId: number;
    wallet: 'cash' | 'treasury';
    amountCenti: bigint;
    reason: string;
    adminUserId: number;
    idempotencyKey?: string;
    requestId?: string;
  },
): Promise<AdjustmentResult> {
  if (input.amountCenti === 0n) return { status: 'invalid_amount' };
  const reason = cleanReason(input.reason);
  if (reason === '') return { status: 'reason_required' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId } = await ctx.config.effectiveAt(tx, now);
    await beginPlayerAction(tx, ctx, input.userId, now);
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' as const };
    }
    const target = (await userWallets(tx, input.userId))[input.wallet];
    if (target.balance + input.amountCenti < 0n) {
      return { status: 'insufficient_funds' as const, balanceCenti: target.balance };
    }
    const transactionId = await postTransaction(tx, {
      kind: 'admin_adjustment',
      effectiveAt: now,
      userId: input.userId,
      adminUserId: input.adminUserId,
      configVersionId: versionId,
      reason,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      entries: [
        { walletId: await systemWalletId(tx, 'adjust:admin'), amount: -input.amountCenti },
        { walletId: target.id, amount: input.amountCenti },
      ],
      metadata: { wallet: input.wallet },
    });
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'balance.adjust',
      targetType: 'user',
      targetId: String(input.userId),
      reason,
      details: { wallet: input.wallet, amountCenti: input.amountCenti.toString(), transactionId },
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return {
      status: 'ok' as const,
      transactionId,
      balanceCenti: target.balance + input.amountCenti,
    };
  });
}
