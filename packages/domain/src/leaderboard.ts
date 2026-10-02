import { queryRows } from '@lulu/database';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DomainContext } from './context.ts';

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  /** Untrusted display text. */
  displayName: string;
  fear: number;
  level: number;
}

interface RankedRow {
  rank: string | number;
  user_id: string | number;
  display_name: string;
  fear: string | number;
  level: number;
}

const toEntry = (r: RankedRow): LeaderboardEntry => ({
  rank: Number(r.rank),
  userId: Number(r.user_id),
  displayName: r.display_name,
  fear: Number(r.fear),
  level: r.level,
});

/**
 * «ترسناک‌ترین لولوها»: fear first, then level, then the stable user id. Fear is one
 * global score per player, so a member of several groups appears with the same value
 * everywhere. Banned players are excluded. Money is not part of this ranking.
 */
function ranked(groupId: number | undefined): SQL {
  const scope =
    groupId === undefined
      ? sql``
      : sql`AND EXISTS (SELECT 1 FROM memberships m
                        WHERE m.user_id = u.id AND m.group_id = ${groupId} AND m.status = 'member')`;
  return sql`
    SELECT row_number() OVER (ORDER BY p.fear DESC, p.level DESC, u.id ASC) AS rank,
           u.id AS user_id, u.display_name, p.fear, p.level
    FROM users u JOIN player_state p ON p.user_id = u.id
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
export async function playerFearRank(
  ctx: DomainContext,
  input: { userId: number; groupId?: number },
): Promise<LeaderboardEntry | null> {
  const rows = await queryRows<RankedRow>(
    ctx.db,
    sql`SELECT * FROM (${ranked(input.groupId)}) r WHERE r.user_id = ${input.userId}`,
  );
  return rows[0] ? toEntry(rows[0]) : null;
}
