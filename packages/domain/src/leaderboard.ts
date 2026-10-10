import { queryRows } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DomainContext } from './context.ts';

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  /** Untrusted display text. */
  displayName: string;
  /** Cash + treasury, in centi-points. */
  pointsCenti: bigint;
  level: number;
}

interface RankedRow {
  rank: string | number;
  user_id: string | number;
  display_name: string;
  points: string;
  level: number;
}

const toEntry = (r: RankedRow): LeaderboardEntry => ({
  rank: Number(r.rank),
  userId: Number(r.user_id),
  displayName: r.display_name,
  pointsCenti: BigInt(r.points),
  level: r.level,
});

/**
 * «ترسناک‌ترین لولوها»: lolopoints first (cash + treasury, so saving in the treasury
 * never costs rank), then level, then the stable user id. Balances are one global
 * value per player, so a member of several groups appears with the same value
 * everywhere. Banned players are excluded. Balances are as last settled; idle accounts
 * catch up through the worker's periodic settlement.
 */
function ranked(groupId: number | undefined): SQL {
  const scope =
    groupId === undefined
      ? sql``
      : sql`AND EXISTS (SELECT 1 FROM memberships m
                        WHERE m.user_id = u.id AND m.group_id = ${groupId} AND m.status = 'member')`;
  return sql`
    SELECT row_number() OVER (ORDER BY b.points DESC, p.level DESC, u.id ASC) AS rank,
           u.id AS user_id, u.display_name, b.points::text AS points, p.level
    FROM users u
    JOIN player_state p ON p.user_id = u.id
    JOIN (SELECT user_id, sum(balance) AS points FROM wallets
          WHERE kind IN ('user_cash', 'user_treasury') GROUP BY user_id) b ON b.user_id = u.id
    WHERE u.banned_at IS NULL ${scope}`;
}

export async function scaryLeaderboard(
  ctx: DomainContext,
  input: { groupId?: number; limit?: number } = {},
): Promise<LeaderboardEntry[]> {
  const rows = await queryRows<RankedRow>(
    ctx.db,
    sql`${ranked(input.groupId)} ORDER BY rank LIMIT ${input.limit ?? 10}`,
  );
  return rows.map(toEntry);
}

/** The player's own position, shown under the top list. `null` if banned or not in the group. */
export async function playerRank(
  ctx: DomainContext,
  input: { userId: number; groupId?: number },
): Promise<LeaderboardEntry | null> {
  const rows = await queryRows<RankedRow>(
    ctx.db,
    sql`SELECT * FROM (${ranked(input.groupId)}) r WHERE r.user_id = ${input.userId}`,
  );
  return rows[0] ? toEntry(rows[0]) : null;
}
