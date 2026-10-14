import { CURSE_KINDS } from '@lulu/config';
import type { Executor, Platform } from '@lulu/database';
import {
  bloodBanks,
  curses,
  groupIdentities,
  groupIdentityHistory,
  groups,
  huntingGrounds,
  inTransaction,
  settlements,
  wallets,
} from '@lulu/database';
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { lockKey } from './players.ts';

export interface GroupIdentityInput {
  platform: Platform;
  platformChatId: string;
  /** Untrusted display text from the platform. */
  title: string;
}

/**
 * Registers a group as a «لولوآباد» when the bot is added. Idempotent: re-adding the
 * bot (also via a pre-migration chat id) reuses the existing city and keeps its data.
 * The full city lifecycle (removal, migration, upgrades) is completed in step 6.
 */
export async function registerGroup(
  ctx: DomainContext,
  input: GroupIdentityInput,
): Promise<{ groupId: number; created: boolean }> {
  const now = ctx.clock.now();
  const title = input.title.trim().slice(0, 128) || '؟';

  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, `group:${input.platform}:${input.platformChatId}`);
    const existing = await findGroupIdByChat(tx, input.platform, input.platformChatId);
    if (existing !== undefined) {
      await tx
        .update(groups)
        .set({ title, botStatus: 'member', botRemovedAt: null, updatedAt: now })
        .where(eq(groups.id, existing));
      return { groupId: existing, created: false };
    }

    const [group] = await tx
      .insert(groups)
      .values({ title, botAddedAt: now, createdAt: now, updatedAt: now })
      .returning({ id: groups.id });
    if (!group) throw new Error('group insert returned nothing');
    const groupId = group.id;
    await tx.insert(groupIdentities).values({
      platform: input.platform,
      platformChatId: input.platformChatId,
      groupId,
      updatedAt: now,
    });
    await tx.insert(settlements).values({ groupId, createdAt: now, updatedAt: now });
    await tx.insert(bloodBanks).values({ groupId, updatedAt: now });
    await tx.insert(huntingGrounds).values({ groupId, updatedAt: now });
    await tx.insert(curses).values(CURSE_KINDS.map((kind) => ({ groupId, kind, updatedAt: now })));
    await tx.insert(wallets).values({ kind: 'group_blood_bank', groupId, createdAt: now });
    return { groupId, created: true };
  });
}

/** Current chat id first, then chat ids the group used before a migration. */
export async function findGroupIdByChat(
  ex: Executor,
  platform: Platform,
  platformChatId: string,
): Promise<number | undefined> {
  const [current] = await ex
    .select({ groupId: groupIdentities.groupId })
    .from(groupIdentities)
    .where(
      and(
        eq(groupIdentities.platform, platform),
        eq(groupIdentities.platformChatId, platformChatId),
      ),
    );
  if (current) return current.groupId;
  const [previous] = await ex
    .select({ groupId: groupIdentityHistory.groupId })
    .from(groupIdentityHistory)
    .where(
      and(
        eq(groupIdentityHistory.platform, platform),
        eq(groupIdentityHistory.platformChatId, platformChatId),
      ),
    );
  return previous?.groupId;
}

export interface GroupBuffs {
  loloEchoLevel: number;
  huntHasteLevel: number;
  huntingGroundLevel: number;
}

/** Buffs of the group the action happens in; buffs of other groups never combine. */
export async function groupBuffs(ex: Executor, groupId: number): Promise<GroupBuffs> {
  const curseRows = await ex
    .select({ kind: curses.kind, level: curses.level })
    .from(curses)
    .where(eq(curses.groupId, groupId));
  const [ground] = await ex
    .select({ level: huntingGrounds.level })
    .from(huntingGrounds)
    .where(eq(huntingGrounds.groupId, groupId));
  if (!ground) throw new Error(`group ${groupId} has no hunting ground`);
  const level = (kind: string) => curseRows.find((c) => c.kind === kind)?.level ?? 0;
  return {
    loloEchoLevel: level('lolo_echo'),
    huntHasteLevel: level('hunt_haste'),
    huntingGroundLevel: ground.level,
  };
}

/** How long a disabled group waits between two «this group is disabled» replies. */
export const DISABLED_NOTICE_INTERVAL_MS = 10 * 60_000;

/**
 * Whether the bot may run commands in a group. A disabled group (set by an admin in the
 * panel) runs nothing; `notify` is true at most once every 10 minutes per group, so the
 * bot can say why without answering every message.
 */
export async function groupGate(
  ex: Executor,
  groupId: number,
  now: Date,
): Promise<{ disabled: false } | { disabled: true; notify: boolean }> {
  const [row] = await ex
    .select({ disabledAt: groups.disabledAt })
    .from(groups)
    .where(eq(groups.id, groupId));
  if (!row || row.disabledAt === null) return { disabled: false };
  const claimed = await ex
    .update(groups)
    .set({ disabledNoticeAt: now })
    .where(
      and(
        eq(groups.id, groupId),
        isNotNull(groups.disabledAt),
        or(
          isNull(groups.disabledNoticeAt),
          lt(groups.disabledNoticeAt, new Date(now.getTime() - DISABLED_NOTICE_INTERVAL_MS)),
        ),
      ),
    )
    .returning({ id: groups.id });
  return { disabled: true, notify: claimed.length > 0 };
}
