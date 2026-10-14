import type { Platform, Tx } from '@lulu/database';
import {
  bloodBanks,
  curses,
  ghostEncounters,
  groupIdentities,
  groupIdentityHistory,
  groupMigrations,
  groups,
  huntingGrounds,
  inTransaction,
  ledgerEntries,
  memberships,
  pendingConfirmations,
  queryRows,
  settlementInventory,
  settlements,
  transactions,
  waitNotices,
  wallets,
} from '@lulu/database';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findGroupIdByChat } from './groups.ts';
import { lockKey } from './players.ts';

/**
 * Bot removed from (or the chat closed for) a group. The city and everything in it is
 * kept; adding the bot again (`registerGroup`) resumes the same city.
 */
export async function botRemovedFromGroup(
  ctx: DomainContext,
  input: { platform: Platform; platformChatId: string },
): Promise<{ status: 'ok'; groupId: number } | { status: 'unknown_group' }> {
  const now = ctx.clock.now();
  const groupId = await findGroupIdByChat(ctx.db, input.platform, input.platformChatId);
  if (groupId === undefined) return { status: 'unknown_group' };
  await ctx.db
    .update(groups)
    .set({ botStatus: 'removed', botRemovedAt: now, updatedAt: now })
    .where(eq(groups.id, groupId));
  return { status: 'ok', groupId };
}

/** A member left the group: no longer counted in its active population. */
export async function memberLeftGroup(
  ctx: DomainContext,
  input: { groupId: number; userId: number },
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db
    .update(memberships)
    .set({ status: 'left', leftAt: now })
    .where(and(eq(memberships.groupId, input.groupId), eq(memberships.userId, input.userId)));
}

/** A city nobody has used yet: no money, history, encounters or successful activity. */
async function isPristine(tx: Tx, groupId: number): Promise<boolean> {
  const [city] = await tx.select().from(settlements).where(eq(settlements.groupId, groupId));
  if (
    city &&
    (city.level !== 1 || city.huntPointsDonatedTotal !== 0 || city.bloodDonatedTotal !== 0n)
  ) {
    return false;
  }
  const [txs] = await tx
    .select({ n: count() })
    .from(transactions)
    .where(eq(transactions.groupId, groupId));
  const [enc] = await tx
    .select({ n: count() })
    .from(ghostEncounters)
    .where(eq(ghostEncounters.groupId, groupId));
  const [active] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.groupId, groupId), isNotNull(memberships.lastSuccessAt)));
  const [entries] = await tx
    .select({ n: count() })
    .from(ledgerEntries)
    .innerJoin(wallets, eq(wallets.id, ledgerEntries.walletId))
    .where(eq(wallets.groupId, groupId));
  return (txs?.n ?? 0) + (enc?.n ?? 0) + (active?.n ?? 0) + (entries?.n ?? 0) === 0;
}

/** Folds an unused city (created for the new chat before the migration was seen) into `intoId`. */
async function absorbPristine(tx: Tx, pristineId: number, intoId: number): Promise<void> {
  await tx.execute(sql`
    INSERT INTO memberships (group_id, user_id, status, joined_at, left_at, last_success_at)
    SELECT ${intoId}, user_id, status, joined_at, left_at, last_success_at
    FROM memberships WHERE group_id = ${pristineId}
    ON CONFLICT (group_id, user_id) DO NOTHING`);
  await tx
    .update(pendingConfirmations)
    .set({ groupId: intoId })
    .where(eq(pendingConfirmations.groupId, pristineId));
  await tx.delete(memberships).where(eq(memberships.groupId, pristineId));
  await tx.delete(waitNotices).where(eq(waitNotices.groupId, pristineId));
  await tx.delete(curses).where(eq(curses.groupId, pristineId));
  await tx.delete(huntingGrounds).where(eq(huntingGrounds.groupId, pristineId));
  await tx.delete(bloodBanks).where(eq(bloodBanks.groupId, pristineId));
  await tx.delete(settlementInventory).where(eq(settlementInventory.groupId, pristineId));
  await tx.delete(settlements).where(eq(settlements.groupId, pristineId));
  await tx.delete(wallets).where(eq(wallets.groupId, pristineId));
  await tx.delete(groupIdentities).where(eq(groupIdentities.groupId, pristineId));
  await tx.delete(groupIdentityHistory).where(eq(groupIdentityHistory.groupId, pristineId));
  await tx.delete(groups).where(eq(groups.id, pristineId));
}

export type MigrateGroupResult =
  | { status: 'migrated'; groupId: number; absorbedGroupId: number | null }
  | { status: 'already_migrated'; groupId: number }
  | { status: 'unknown_group' }
  /** The new chat already has a city with real data; left for an admin to resolve. */
  | { status: 'conflict'; groupId: number; otherGroupId: number };

/**
 * A group became a supergroup (new chat id). The same city continues under the new id:
 * no new city, no data moved. The old id is kept in the history so late updates and
 * replies to messages posted before the migration (which still belong to the old
 * chat) resolve to the same city. Pending outgoing messages and confirmation buttons
 * are re-addressed to the new chat. Idempotent.
 */
export async function migrateGroupChat(
  ctx: DomainContext,
  input: { platform: Platform; fromChatId: string; toChatId: string },
): Promise<MigrateGroupResult> {
  const now = ctx.clock.now();
  const { platform, fromChatId, toChatId } = input;
  return inTransaction(ctx.db, async (tx) => {
    for (const chat of [fromChatId, toChatId].sort())
      await lockKey(tx, `group:${platform}:${chat}`);

    const [current] = await tx
      .select({ groupId: groupIdentities.groupId })
      .from(groupIdentities)
      .where(
        and(eq(groupIdentities.platform, platform), eq(groupIdentities.platformChatId, fromChatId)),
      );
    if (!current) {
      const [previous] = await tx
        .select({ groupId: groupIdentityHistory.groupId })
        .from(groupIdentityHistory)
        .where(
          and(
            eq(groupIdentityHistory.platform, platform),
            eq(groupIdentityHistory.platformChatId, fromChatId),
          ),
        );
      if (previous && (await findGroupIdByChat(tx, platform, toChatId)) === previous.groupId) {
        return { status: 'already_migrated' as const, groupId: previous.groupId };
      }
      return { status: 'unknown_group' as const };
    }

    const groupId = current.groupId;
    const existingTarget = await findGroupIdByChat(tx, platform, toChatId);
    let absorbedGroupId: number | null = null;
    if (existingTarget !== undefined && existingTarget !== groupId) {
      if (!(await isPristine(tx, existingTarget))) {
        // Recorded for the admin panel; a redelivered update adds no second open row.
        await tx
          .insert(groupMigrations)
          .values({
            platform,
            fromChatId,
            toChatId,
            groupId,
            status: 'conflict',
            otherGroupId: existingTarget,
            detectedAt: now,
          })
          .onConflictDoNothing();
        return { status: 'conflict' as const, groupId, otherGroupId: existingTarget };
      }
      await absorbPristine(tx, existingTarget, groupId);
      absorbedGroupId = existingTarget;
    }

    await tx
      .insert(groupIdentityHistory)
      .values({ platform, platformChatId: fromChatId, groupId, replacedAt: now })
      .onConflictDoNothing();
    await tx
      .update(groupIdentities)
      .set({ platformChatId: toChatId, updatedAt: now })
      .where(
        and(eq(groupIdentities.platform, platform), eq(groupIdentities.platformChatId, fromChatId)),
      );
    await queryRows(
      tx,
      sql`UPDATE outbox SET payload = jsonb_set(payload, '{platformChatId}', to_jsonb(${toChatId}::text))
          WHERE platform = ${platform} AND status = 'pending' AND payload->>'platformChatId' = ${fromChatId}
          RETURNING id`,
    );
    await tx
      .update(pendingConfirmations)
      .set({ chatId: toChatId })
      .where(
        and(
          eq(pendingConfirmations.platform, platform),
          eq(pendingConfirmations.chatId, fromChatId),
        ),
      );
    await tx.update(groups).set({ updatedAt: now }).where(eq(groups.id, groupId));
    await tx.insert(groupMigrations).values({
      platform,
      fromChatId,
      toChatId,
      groupId,
      status: 'migrated',
      absorbedGroupId,
      detectedAt: now,
    });
    return { status: 'migrated' as const, groupId, absorbedGroupId };
  });
}
