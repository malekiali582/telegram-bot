import { inTransaction, interestSettlements, playerState, users } from '@lulu/database';
import { desc, eq } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { DomainError } from './context.ts';
import { findTransactionByKey, postTransaction, userWallets } from './ledger.ts';
import { beginPlayerAction } from './players.ts';
import { nextTehranMidnight } from './tehran.ts';

export interface TreasuryView {
  status: 'ok';
  cashCenti: bigint;
  treasuryCenti: bigint;
  dailyInterestBp: number;
  nextInterestAt: Date;
  lastInterest: { boundaryDate: string; interestCenti: bigint } | null;
}

/** «گنجینه» / «لولوهام»: balances after settling every past midnight. */
export async function treasuryView(
  ctx: DomainContext,
  userId: number,
): Promise<TreasuryView | { status: 'banned' }> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, userId, now);
    if (player.banned) return { status: 'banned' as const };
    const { cash, treasury } = await userWallets(tx, userId);
    const [last] = await tx
      .select({
        boundaryDate: interestSettlements.boundaryDate,
        interest: interestSettlements.interest,
      })
      .from(interestSettlements)
      .where(eq(interestSettlements.userId, userId))
      .orderBy(desc(interestSettlements.boundaryDate))
      .limit(1);
    return {
      status: 'ok' as const,
      cashCenti: cash.balance,
      treasuryCenti: treasury.balance,
      dailyInterestBp: config.treasury.dailyInterestBp,
      nextInterestAt: nextTehranMidnight(now),
      lastInterest: last ? { boundaryDate: last.boundaryDate, interestCenti: last.interest } : null,
    };
  });
}

export type TreasuryMoveResult =
  | {
      status: 'ok';
      amountCenti: bigint;
      cashCenti: bigint;
      treasuryCenti: bigint;
      transactionId: number;
    }
  | { status: 'invalid_amount' }
  | { status: 'insufficient_funds'; availableCenti: bigint }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * Moves money between the player's own cash and treasury. Their sum is unchanged.
 * Settlement runs first, so a move made after a midnight never takes part in that
 * midnight's interest, and a move made before it does.
 */
async function moveTreasury(
  ctx: DomainContext,
  direction: 'deposit' | 'withdraw',
  input: { userId: number; amountCenti: bigint; idempotencyKey?: string },
): Promise<TreasuryMoveResult> {
  if (input.amountCenti <= 0n) return { status: 'invalid_amount' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    const { cash, treasury } = await userWallets(tx, input.userId);
    const [from, to] = direction === 'deposit' ? [cash, treasury] : [treasury, cash];
    if (from.balance < input.amountCenti) {
      return { status: 'insufficient_funds', availableCenti: from.balance };
    }
    const transactionId = await postTransaction(tx, {
      kind: direction === 'deposit' ? 'treasury_deposit' : 'treasury_withdraw',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [
        { walletId: from.id, amount: -input.amountCenti },
        { walletId: to.id, amount: input.amountCenti },
      ],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const delta = direction === 'deposit' ? input.amountCenti : -input.amountCenti;
    return {
      status: 'ok',
      amountCenti: input.amountCenti,
      cashCenti: cash.balance - delta,
      treasuryCenti: treasury.balance + delta,
      transactionId,
    };
  });
}

export const depositToTreasury = (
  ctx: DomainContext,
  input: { userId: number; amountCenti: bigint; idempotencyKey?: string },
) => moveTreasury(ctx, 'deposit', input);

export const withdrawFromTreasury = (
  ctx: DomainContext,
  input: { userId: number; amountCenti: bigint; idempotencyKey?: string },
) => moveTreasury(ctx, 'withdraw', input);

export type TransferResult =
  | {
      status: 'ok';
      amountCenti: bigint;
      senderCashCenti: bigint;
      recipientUserId: number;
      transactionId: number;
    }
  | { status: 'invalid_amount' }
  | { status: 'self_transfer' }
  | { status: 'unknown_recipient' }
  | { status: 'recipient_banned' }
  | { status: 'insufficient_funds'; availableCenti: bigint }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * «انتقال»: cash to another registered player's cash, all or nothing, fee 0 in v1.
 * Both players are locked in id order, so opposite-direction transfers between the
 * same two players cannot deadlock. Treasury (interest-bearing) money is never moved
 * directly, so a transfer cannot make the same money earn one midnight twice.
 */
export async function transfer(
  ctx: DomainContext,
  input: {
    fromUserId: number;
    toUserId: number;
    amountCenti: bigint;
    groupId?: number;
    idempotencyKey?: string;
  },
): Promise<TransferResult> {
  if (input.amountCenti <= 0n) return { status: 'invalid_amount' };
  if (input.fromUserId === input.toUserId) return { status: 'self_transfer' };
  const now = ctx.clock.now();

  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    if (config.transfer.feeBp !== 0) {
      // v1 has no fee account or fee rules; refuse rather than silently ignore a fee.
      throw new DomainError('fee_not_supported', 'transfer fees are not implemented in v1');
    }
    const [recipient] = await tx
      .select({ id: users.id, isBot: users.isBot })
      .from(users)
      .innerJoin(playerState, eq(playerState.userId, users.id))
      .where(eq(users.id, input.toUserId));
    if (!recipient || recipient.isBot) return { status: 'unknown_recipient' };

    const [firstId, secondId] =
      input.fromUserId < input.toUserId
        ? [input.fromUserId, input.toUserId]
        : [input.toUserId, input.fromUserId];
    const first = await beginPlayerAction(tx, ctx, firstId, now);
    const second = await beginPlayerAction(tx, ctx, secondId, now);
    const sender = first.userId === input.fromUserId ? first : second;
    const receiver = sender === first ? second : first;
    if (sender.banned) return { status: 'banned' };
    if (receiver.banned) return { status: 'recipient_banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }

    const { cash: senderCash } = await userWallets(tx, input.fromUserId);
    if (senderCash.balance < input.amountCenti) {
      return { status: 'insufficient_funds', availableCenti: senderCash.balance };
    }
    const { cash: recipientCash } = await userWallets(tx, input.toUserId);
    const transactionId = await postTransaction(tx, {
      kind: 'transfer',
      effectiveAt: now,
      userId: input.fromUserId,
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      configVersionId: versionId,
      entries: [
        { walletId: senderCash.id, amount: -input.amountCenti },
        { walletId: recipientCash.id, amount: input.amountCenti },
      ],
      metadata: { toUserId: input.toUserId },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return {
      status: 'ok',
      amountCenti: input.amountCenti,
      senderCashCenti: senderCash.balance - input.amountCenti,
      recipientUserId: input.toUserId,
      transactionId,
    };
  });
}
