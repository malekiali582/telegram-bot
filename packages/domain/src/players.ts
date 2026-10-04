import type { Executor, Platform, Tx } from '@lulu/database';
import {
  inTransaction,
  lockPlayer,
  memberships,
  playerState,
  userIdentities,
  users,
  wallets,
} from '@lulu/database';
import { and, eq, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { DomainError } from './context.ts';
import { settleCemetery, settleInterest } from './settlement.ts';

export interface PlayerIdentityInput {
  platform: Platform;
  platformUserId: string;
  /** Untrusted display text from the platform. */
  displayName: string;
  username?: string | null;
  isBot?: boolean;
}

export type RegisterPlayerResult =
  { status: 'ok'; userId: number; created: boolean } | { status: 'rejected_bot' };

const MAX_NAME = 64;
const cleanName = (name: string) => name.trim().slice(0, MAX_NAME) || '؟';

/** Serializes work on one external identity (player or chat) inside a transaction. */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * `/start` and first contact. Idempotent: a known identity only refreshes its name;
 * a new one gets a level-1 player with zero balances. Never grants a reward.
 */
export async function registerPlayer(
  ctx: DomainContext,
  input: PlayerIdentityInput,
): Promise<RegisterPlayerResult> {
  if (input.isBot) return { status: 'rejected_bot' };
  const now = ctx.clock.now();
  const displayName = cleanName(input.displayName);
  const username = input.username ?? null;

  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, `user:${input.platform}:${input.platformUserId}`);
    const [identity] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.platform, input.platform),
          eq(userIdentities.platformUserId, input.platformUserId),
        ),
      );

    if (identity) {
      await tx
        .update(users)
        .set({ displayName, username, updatedAt: now })
        .where(
          and(
            eq(users.id, identity.userId),
            sql`(${users.displayName}, ${users.username}) IS DISTINCT FROM (${displayName}, ${username})`,
          ),
        );
      return { status: 'ok' as const, userId: identity.userId, created: false };
    }

    const [user] = await tx
      .insert(users)
      .values({ displayName, username, createdAt: now, updatedAt: now })
      .returning({ id: users.id });
    if (!user) throw new Error('user insert returned nothing');
    await tx
      .insert(playerState)
      .values({ userId: user.id, startedAt: now, createdAt: now, updatedAt: now });
    await tx.insert(wallets).values([
      { kind: 'user_cash', userId: user.id, createdAt: now },
      { kind: 'user_treasury', userId: user.id, createdAt: now },
    ]);
    await tx.insert(userIdentities).values({
      platform: input.platform,
      platformUserId: input.platformUserId,
      userId: user.id,
      createdAt: now,
    });
    return { status: 'ok' as const, userId: user.id, created: true };
  });
}

export async function findUserIdByIdentity(
  ex: Executor,
  platform: Platform,
  platformUserId: string,
): Promise<number | undefined> {
  const [row] = await ex
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.platform, platform), eq(userIdentities.platformUserId, platformUserId)),
    );
  return row?.userId;
}

export interface LockedPlayer {
  userId: number;
  level: number;
  equippedTool: string | null;
  startedAt: Date;
  lastLoloAt: Date | null;
  banned: boolean;
}

/**
 * First step of every player action: takes the player-wide lock (shared by all groups)
 * so concurrent actions for the same player run one after another, then settles what
 * is owed up to `now`: midnight interest (by effective time) and cemetery income.
 * Every read or change of a balance therefore sees settled values.
 */
export async function beginPlayerAction(
  tx: Tx,
  ctx: DomainContext,
  userId: number,
  now: Date,
): Promise<LockedPlayer> {
  const state = await lockPlayer(tx, userId);
  if (!state) throw new DomainError('unknown_player', `player ${userId} is not registered`);
  const [user] = await tx
    .select({ bannedAt: users.bannedAt })
    .from(users)
    .where(eq(users.id, userId));
  await settleInterest(tx, ctx, state, now);
  await settleCemetery(tx, ctx, userId, now);
  return {
    userId,
    level: state.level,
    equippedTool: state.equippedTool,
    startedAt: state.startedAt,
    lastLoloAt: state.lastLoloAt,
    banned: (user?.bannedAt ?? null) !== null,
  };
}

/**
 * Any command a player sends in a group shows they are in it, so they count as a member
 * (e.g. for the group's «ترسناک‌ترین لولوها») even before a successful «لولو» there.
 * Does not record a successful activity, and writes nothing if already a member.
 */
export async function noteGroupPresence(
  ctx: DomainContext,
  input: { groupId: number; userId: number },
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db
    .insert(memberships)
    .values({ groupId: input.groupId, userId: input.userId, status: 'member', joinedAt: now })
    .onConflictDoUpdate({
      target: [memberships.groupId, memberships.userId],
      set: { status: 'member', leftAt: null },
      setWhere: sql`${memberships.status} <> 'member'`,
    });
}

/** Records that the player is in the group, and optionally a successful activity there. */
export async function touchMembership(
  tx: Tx,
  groupId: number,
  userId: number,
  now: Date,
  successfulActivity: boolean,
): Promise<void> {
  await tx
    .insert(memberships)
    .values({
      groupId,
      userId,
      status: 'member',
      joinedAt: now,
      lastSuccessAt: successfulActivity ? now : null,
    })
    .onConflictDoUpdate({
      target: [memberships.groupId, memberships.userId],
      set: {
        status: 'member',
        leftAt: null,
        lastSuccessAt: successfulActivity ? now : sql`${memberships.lastSuccessAt}`,
      },
    });
}
