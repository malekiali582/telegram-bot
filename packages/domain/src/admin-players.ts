import type { Platform } from '@lulu/database';
import { queryRows } from '@lulu/database';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import type { PlayerProfile } from './profile.ts';
import { playerProfile } from './profile.ts';
import { addDays, tehranDate } from './tehran.ts';

/**
 * Player lookups for the admin panel. Read-only, except that opening a profile settles
 * the player's due income first (the same lazy settlement any player action runs), so
 * the balances shown are current.
 */

export type PlayerSort = 'recent' | 'newest' | 'richest';

export interface PlayerSearchInput {
  /** Name, @username, internal id or platform id. */
  query?: string;
  banned?: 'only' | 'exclude';
  platform?: Platform;
  sort?: PlayerSort;
  limit: number;
  offset: number;
}

export interface PlayerListItem {
  id: number;
  /** Untrusted display text. */
  displayName: string;
  username: string | null;
  isSample: boolean;
  bannedAt: Date | null;
  createdAt: Date;
  level: number;
  cashCenti: bigint;
  treasuryCenti: bigint;
  identities: { platform: Platform; platformUserId: string }[];
  /** Last successful activity in any group. */
  lastActiveAt: Date | null;
}

/** Arabic yeh/kaf and the like typed into Persian text: compared as Persian letters. */
const ARABIC = 'يكىة';
const PERSIAN = 'یکیه';
const fold = (s: string) => s.replace(/[يكىة]/g, (c) => PERSIAN[ARABIC.indexOf(c)]!);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchCondition(raw: string): SQL {
  const query = fold(raw.trim()).slice(0, 100);
  if (/^@[\w.]{1,64}$/.test(query)) {
    return sql`u.username ILIKE ${likeEscape(query.slice(1))}`;
  }
  const like = `%${likeEscape(query)}%`;
  const byIdentity = sql`EXISTS (SELECT 1 FROM user_identities ui
                         WHERE ui.user_id = u.id AND ui.platform_user_id = ${query})`;
  const byName = sql`(translate(u.display_name, ${ARABIC}, ${PERSIAN}) ILIKE ${like}
                      OR u.username ILIKE ${like})`;
  if (/^\d{1,18}$/.test(query)) {
    return sql`(u.id = ${Number(query) <= Number.MAX_SAFE_INTEGER ? Number(query) : -1}
                OR ${byIdentity} OR ${byName})`;
  }
  return sql`(${byIdentity} OR ${byName})`;
}

export async function searchPlayers(
  ctx: DomainContext,
  input: PlayerSearchInput,
): Promise<{ items: PlayerListItem[]; total: number }> {
  const where: SQL[] = [sql`NOT u.is_bot`];
  if (input.query?.trim()) where.push(searchCondition(input.query));
  if (input.banned === 'only') where.push(sql`u.banned_at IS NOT NULL`);
  if (input.banned === 'exclude') where.push(sql`u.banned_at IS NULL`);
  if (input.platform) {
    where.push(sql`EXISTS (SELECT 1 FROM user_identities ui
                   WHERE ui.user_id = u.id AND ui.platform = ${input.platform})`);
  }
  const condition = sql.join(where, sql` AND `);
  const order =
    input.sort === 'newest'
      ? sql`u.id DESC`
      : input.sort === 'richest'
        ? sql`(coalesce(c.balance, 0) + coalesce(t.balance, 0)) DESC, u.id DESC`
        : sql`last_active DESC NULLS LAST, u.id DESC`;

  const rows = await queryRows<{
    id: number | string;
    display_name: string;
    username: string | null;
    is_sample: boolean;
    banned_at: Date | null;
    created_at: Date;
    level: number | null;
    cash: string | null;
    treasury: string | null;
    identities: { platform: Platform; platformUserId: string }[] | null;
    last_active: Date | null;
  }>(
    ctx.db,
    sql`SELECT u.id, u.display_name, u.username, u.is_sample, u.banned_at, u.created_at,
               p.level, c.balance::text AS cash, t.balance::text AS treasury,
               (SELECT json_agg(json_build_object('platform', ui.platform,
                                                  'platformUserId', ui.platform_user_id)
                                ORDER BY ui.platform)
                  FROM user_identities ui WHERE ui.user_id = u.id) AS identities,
               (SELECT max(m.last_success_at) FROM memberships m WHERE m.user_id = u.id) AS last_active
        FROM users u
        LEFT JOIN player_state p ON p.user_id = u.id
        LEFT JOIN wallets c ON c.user_id = u.id AND c.kind = 'user_cash'
        LEFT JOIN wallets t ON t.user_id = u.id AND t.kind = 'user_treasury'
        WHERE ${condition}
        ORDER BY ${order}
        LIMIT ${input.limit} OFFSET ${input.offset}`,
  );
  const [count] = await queryRows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM users u WHERE ${condition}`,
  );
  return {
    total: count?.n ?? 0,
    items: rows.map((r) => ({
      id: Number(r.id),
      displayName: r.display_name,
      username: r.username,
      isSample: r.is_sample,
      bannedAt: r.banned_at === null ? null : new Date(r.banned_at),
      createdAt: new Date(r.created_at),
      level: r.level ?? 1,
      cashCenti: BigInt(r.cash ?? '0'),
      treasuryCenti: BigInt(r.treasury ?? '0'),
      identities: r.identities ?? [],
      lastActiveAt: r.last_active === null ? null : new Date(r.last_active),
    })),
  };
}

export interface PlayerGroupView {
  groupId: number;
  /** Untrusted display text. */
  title: string;
  platform: Platform | null;
  botPresent: boolean;
  status: 'member' | 'left';
  joinedAt: Date;
  lastSuccessAt: Date | null;
  /** Consecutive days with a «لولو» here, if the run is still alive (today or yesterday). */
  streak: number;
}

export interface PlayerGhostView {
  id: number;
  groupId: number;
  groupTitle: string;
  foundAt: Date;
  heardAt: Date | null;
  expiresAt: Date;
  /** Untrusted text snapshot. */
  text: string;
}

export interface AdminPlayerDetail {
  profile: PlayerProfile;
  user: {
    id: number;
    displayName: string;
    username: string | null;
    isSample: boolean;
    createdAt: Date;
    bannedAt: Date | null;
    banReason: string | null;
  };
  identities: { platform: Platform; platformUserId: string; createdAt: Date }[];
  groups: PlayerGroupView[];
  ghosts: { foundTotal: number; heardTotal: number; recent: PlayerGhostView[] };
  streakRewards: {
    date: string;
    groupId: number;
    groupTitle: string;
    streak: number;
    activeMembers: number;
    personalCenti: bigint;
    groupCenti: bigint;
  }[];
}

export async function adminPlayerDetail(
  ctx: DomainContext,
  userId: number,
): Promise<AdminPlayerDetail | null> {
  const [user] = await queryRows<{
    id: number | string;
    display_name: string;
    username: string | null;
    is_sample: boolean;
    created_at: Date;
    banned_at: Date | null;
    ban_reason: string | null;
  }>(ctx.db, sql`SELECT * FROM users WHERE id = ${userId} AND NOT is_bot`);
  if (!user) return null;

  const profile = await playerProfile(ctx, userId);
  const today = tehranDate(ctx.clock.now());
  const yesterday = addDays(today, -1);

  const identities = await queryRows<{
    platform: Platform;
    platform_user_id: string;
    created_at: Date;
  }>(
    ctx.db,
    sql`SELECT platform, platform_user_id, created_at FROM user_identities
        WHERE user_id = ${userId} ORDER BY platform`,
  );
  const groups = await queryRows<{
    group_id: number | string;
    title: string;
    platform: Platform | null;
    bot_status: 'member' | 'removed';
    status: 'member' | 'left';
    joined_at: Date;
    last_success_at: Date | null;
    streak_day: string | null;
    streak: number | null;
  }>(
    ctx.db,
    sql`SELECT m.group_id, g.title, gi.platform, g.bot_status, m.status, m.joined_at,
               m.last_success_at, to_char(s.tehran_date, 'YYYY-MM-DD') AS streak_day, s.streak
        FROM memberships m
        JOIN groups g ON g.id = m.group_id
        LEFT JOIN group_identities gi ON gi.group_id = g.id
        LEFT JOIN LATERAL (SELECT tehran_date, streak FROM streak_days sd
                           WHERE sd.user_id = m.user_id AND sd.group_id = m.group_id
                           ORDER BY tehran_date DESC LIMIT 1) s ON true
        WHERE m.user_id = ${userId}
        ORDER BY m.status, m.last_success_at DESC NULLS LAST, m.group_id`,
  );
  const [ghostCounts] = await queryRows<{ found: number; heard: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS found, count(heard_at)::int AS heard
        FROM ghost_encounters WHERE user_id = ${userId}`,
  );
  const ghosts = await queryRows<{
    id: number | string;
    group_id: number | string;
    title: string;
    found_at: Date;
    heard_at: Date | null;
    expires_at: Date;
    text_snapshot: string;
  }>(
    ctx.db,
    sql`SELECT e.id, e.group_id, g.title, e.found_at, e.heard_at, e.expires_at, e.text_snapshot
        FROM ghost_encounters e JOIN groups g ON g.id = e.group_id
        WHERE e.user_id = ${userId} ORDER BY e.found_at DESC, e.id DESC LIMIT 10`,
  );
  const rewards = await queryRows<{
    date: string;
    group_id: number | string;
    title: string;
    streak: number;
    active_members: number;
    personal_centi: string;
    group_centi: string;
  }>(
    ctx.db,
    sql`SELECT to_char(r.tehran_date, 'YYYY-MM-DD') AS date, r.group_id, g.title, r.streak,
               r.active_members, r.personal_centi::text, r.group_centi::text
        FROM streak_rewards r JOIN groups g ON g.id = r.group_id
        WHERE r.user_id = ${userId} ORDER BY r.tehran_date DESC LIMIT 7`,
  );

  return {
    profile,
    user: {
      id: Number(user.id),
      displayName: user.display_name,
      username: user.username,
      isSample: user.is_sample,
      createdAt: new Date(user.created_at),
      bannedAt: user.banned_at === null ? null : new Date(user.banned_at),
      banReason: user.ban_reason,
    },
    identities: identities.map((i) => ({
      platform: i.platform,
      platformUserId: i.platform_user_id,
      createdAt: new Date(i.created_at),
    })),
    groups: groups.map((g) => ({
      groupId: Number(g.group_id),
      title: g.title,
      platform: g.platform,
      botPresent: g.bot_status === 'member',
      status: g.status,
      joinedAt: new Date(g.joined_at),
      lastSuccessAt: g.last_success_at === null ? null : new Date(g.last_success_at),
      streak: g.streak_day === today || g.streak_day === yesterday ? (g.streak ?? 0) : 0,
    })),
    ghosts: {
      foundTotal: ghostCounts?.found ?? 0,
      heardTotal: ghostCounts?.heard ?? 0,
      recent: ghosts.map((e) => ({
        id: Number(e.id),
        groupId: Number(e.group_id),
        groupTitle: e.title,
        foundAt: new Date(e.found_at),
        heardAt: e.heard_at === null ? null : new Date(e.heard_at),
        expiresAt: new Date(e.expires_at),
        text: e.text_snapshot,
      })),
    },
    streakRewards: rewards.map((r) => ({
      date: r.date,
      groupId: Number(r.group_id),
      groupTitle: r.title,
      streak: r.streak,
      activeMembers: r.active_members,
      personalCenti: BigInt(r.personal_centi),
      groupCenti: BigInt(r.group_centi),
    })),
  };
}
