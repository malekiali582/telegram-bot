import type { GameConfig } from '@lulu/config';
import type { Executor, Tx } from '@lulu/database';
import { playerState, queryRows, streakDays, streakRewards } from '@lulu/database';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { addDays, tehranDate, tehranMidnight } from './tehran.ts';

/**
 * Daily group-activity reward with a streak (all values suggested, see config `streak`):
 *
 * - A streak day is a Tehran day with at least one successful «لولو» in a group. Each
 *   group has its own streak; a day without a lolo there resets it.
 * - For every finished day the player is paid once, from one group: personal reward
 *   (10, +5 per consecutive day, flat from day 30) + 100 × min(active members, 20).
 * - Active members of a group on a day: players with a successful lolo there that day
 *   whose first lolo anywhere was at least 3 Tehran days before. Banned players are
 *   neither counted nor paid.
 * - A player active in several groups is paid from the one with the most active
 *   members that day; ties go to the longer streak, then the lower group id.
 */

/** Personal part of the reward for a streak of `streak` days, in whole points. */
export function personalStreakReward(config: GameConfig, streak: number): number {
  const s = config.streak;
  return s.baseReward + s.dailyIncrement * (Math.min(streak, s.maxDays) - 1);
}

/** Group part of the reward for `activeMembers` members, in whole points. */
export function groupStreakReward(config: GameConfig, activeMembers: number): number {
  const s = config.streak;
  return s.groupRewardPerMember * Math.min(activeMembers, s.groupMemberCap);
}

/**
 * Called by every successful «لولو» (under the player lock): marks today as a streak day
 * in this group, continuing yesterday's streak there if it had one, and remembers the
 * player's first lolo day. The previous day is already over, so its streak is final.
 */
export async function recordStreakDay(
  tx: Tx,
  input: { userId: number; groupId: number; now: Date },
): Promise<number> {
  const today = tehranDate(input.now);
  const [prev] = await tx
    .select({ streak: streakDays.streak })
    .from(streakDays)
    .where(
      and(
        eq(streakDays.userId, input.userId),
        eq(streakDays.groupId, input.groupId),
        eq(streakDays.tehranDate, addDays(today, -1)),
      ),
    );
  const streak = (prev?.streak ?? 0) + 1;
  await tx
    .insert(streakDays)
    .values({ userId: input.userId, groupId: input.groupId, tehranDate: today, streak })
    .onConflictDoNothing();
  await tx
    .update(playerState)
    .set({ firstLoloDate: today })
    .where(and(eq(playerState.userId, input.userId), isNull(playerState.firstLoloDate)));
  return streak;
}

/** Active members of a group on a Tehran day (see the rules above). */
export async function activeMembersOn(
  ex: Executor,
  config: GameConfig,
  groupId: number,
  date: string,
): Promise<number> {
  const cutoff = addDays(date, -config.streak.minAccountAgeDays);
  const [row] = await queryRows<{ n: string | number }>(
    ex,
    sql`SELECT count(*) AS n
        FROM streak_days s
        JOIN player_state p ON p.user_id = s.user_id
        JOIN users u ON u.id = s.user_id
        WHERE s.group_id = ${groupId} AND s.tehran_date = ${date}::date
          AND p.first_lolo_date <= ${cutoff}::date AND u.banned_at IS NULL`,
  );
  return Number(row?.n ?? 0);
}

export interface StreakSettlementResult {
  days: string[];
  creditedCenti: bigint;
}

/**
 * Pays the streak reward of every finished Tehran day not yet settled, in date order,
 * each as of its own midnight (configuration in force then). Runs under the player lock
 * from beginPlayerAction and from the worker. `streak_rewards (user, day)` makes a
 * second payment impossible; `streak_settled_through` makes repeated runs cheap.
 * Counts depend only on stored lolo days, so a late run pays exactly what a run at
 * midnight would have.
 */
export async function settleStreaks(
  tx: Tx,
  ctx: DomainContext,
  player: { userId: number; streakSettledThrough: string | null; banned: boolean },
  now: Date,
): Promise<StreakSettlementResult> {
  const result: StreakSettlementResult = { days: [], creditedCenti: 0n };
  const lastDue = addDays(tehranDate(now), -1); // the latest day whose midnight has passed
  const after = player.streakSettledThrough;
  if (after !== null && after >= lastDue) return result;

  const rows = await tx
    .select()
    .from(streakDays)
    .where(
      and(
        eq(streakDays.userId, player.userId),
        lte(streakDays.tehranDate, lastDue),
        ...(after === null ? [] : [gt(streakDays.tehranDate, after)]),
      ),
    )
    .orderBy(asc(streakDays.tehranDate), asc(streakDays.groupId));

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) byDay.set(r.tehranDate, [...(byDay.get(r.tehranDate) ?? []), r]);

  for (const [date, candidates] of byDay) {
    const midnight = tehranMidnight(addDays(date, 1));
    const { versionId, config } = await ctx.config.effectiveAt(tx, midnight);
    let best: { groupId: number; streak: number; active: number } | null = null;
    for (const c of candidates) {
      const active = await activeMembersOn(tx, config, c.groupId, date);
      if (
        !best ||
        active > best.active ||
        (active === best.active && c.streak > best.streak) ||
        (active === best.active && c.streak === best.streak && c.groupId < best.groupId)
      ) {
        best = { groupId: c.groupId, streak: c.streak, active };
      }
    }
    if (!best || player.banned) continue;

    const personal = pointsToCenti(personalStreakReward(config, best.streak));
    const group = pointsToCenti(groupStreakReward(config, best.active));
    const [fresh] = await tx
      .insert(streakRewards)
      .values({
        userId: player.userId,
        tehranDate: date,
        groupId: best.groupId,
        streak: best.streak,
        activeMembers: best.active,
        personalCenti: personal,
        groupCenti: group,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ userId: streakRewards.userId });
    if (!fresh) continue; // already paid

    const total = personal + group;
    const { cash } = await userWallets(tx, player.userId);
    const transactionId = await postTransaction(tx, {
      kind: 'streak_reward',
      effectiveAt: midnight,
      userId: player.userId,
      groupId: best.groupId,
      configVersionId: versionId,
      idempotencyKey: `streak:${player.userId}:${date}`,
      entries: [
        { walletId: await systemWalletId(tx, 'mint:streak'), amount: -total },
        { walletId: cash.id, amount: total },
      ],
      metadata: {
        day: date,
        streak: best.streak,
        activeMembers: best.active,
        personalCenti: personal.toString(),
        groupCenti: group.toString(),
      },
    });
    await tx
      .update(streakRewards)
      .set({ transactionId })
      .where(and(eq(streakRewards.userId, player.userId), eq(streakRewards.tehranDate, date)));
    result.days.push(date);
    result.creditedCenti += total;
  }

  await tx
    .update(playerState)
    .set({ streakSettledThrough: lastDue })
    .where(eq(playerState.userId, player.userId));
  return result;
}

export interface StreakRewardView {
  day: string;
  groupId: number;
  streak: number;
  activeMembers: number;
  personalCenti: bigint;
  groupCenti: bigint;
}

/** The player's latest streak payment, for «غار من». */
export async function lastStreakReward(
  ex: Executor,
  userId: number,
): Promise<StreakRewardView | null> {
  const [row] = await ex
    .select()
    .from(streakRewards)
    .where(eq(streakRewards.userId, userId))
    .orderBy(sql`${streakRewards.tehranDate} DESC`)
    .limit(1);
  return row
    ? {
        day: row.tehranDate,
        groupId: row.groupId,
        streak: row.streak,
        activeMembers: row.activeMembers,
        personalCenti: row.personalCenti,
        groupCenti: row.groupCenti,
      }
    : null;
}
