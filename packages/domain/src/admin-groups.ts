import type { Platform } from '@lulu/database';
import { auditLogs, groupMigrations, groups, inTransaction, queryRows } from '@lulu/database';
import type { SQL } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CityView } from './city.ts';
import { cityView } from './city.ts';
import type { DomainContext } from './context.ts';
import type { LeaderboardEntry } from './leaderboard.ts';
import { scaryLeaderboard } from './leaderboard.ts';

/**
 * Groups («لولوآباد»ها) for the admin panel: search, detail, disabling, and the record
 * of supergroup migrations. Disabling only stops the bot from running commands there;
 * the city and every balance are kept.
 */

export type GroupStatusFilter = 'active' | 'disabled' | 'removed';
export type GroupSort = 'recent' | 'newest' | 'members';

export interface GroupListItem {
  id: number;
  /** Untrusted display text. */
  title: string;
  isSample: boolean;
  platform: Platform | null;
  chatId: string | null;
  botPresent: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  cityLevel: number;
  bloodBankCenti: bigint;
  members: number;
  /** Members with a successful activity within the city's population window. */
  activeMembers: number;
  lastActivityAt: Date | null;
  /** Chat ids the group used before supergroup migrations. */
  previousChatIds: number;
}

const ARABIC = 'يكىة';
const PERSIAN = 'یکیه';
const fold = (s: string) => s.replace(/[يكىة]/g, (c) => PERSIAN[ARABIC.indexOf(c)]!);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchGroups(
  ctx: DomainContext,
  input: {
    query?: string;
    status?: GroupStatusFilter;
    platform?: Platform;
    sort?: GroupSort;
    limit: number;
    offset: number;
  },
): Promise<{ items: GroupListItem[]; total: number }> {
  const now = ctx.clock.now();
  const { config } = await ctx.config.effectiveAt(ctx.db, now);
  const since = new Date(now.getTime() - config.city.activePopulationWindowDays * 86_400_000);

  const where: SQL[] = [sql`true`];
  const q = fold(input.query?.trim() ?? '').slice(0, 100);
  if (q) {
    const byChat = sql`EXISTS (SELECT 1 FROM group_identities gi2 WHERE gi2.group_id = g.id
                                 AND gi2.platform_chat_id = ${q})
                       OR EXISTS (SELECT 1 FROM group_identity_history gh WHERE gh.group_id = g.id
                                 AND gh.platform_chat_id = ${q})`;
    const byTitle = sql`translate(g.title, ${ARABIC}, ${PERSIAN}) ILIKE ${`%${likeEscape(q)}%`}`;
    where.push(
      /^\d{1,15}$/.test(q)
        ? sql`(g.id = ${Number(q)} OR ${byChat} OR ${byTitle})`
        : sql`(${byChat} OR ${byTitle})`,
    );
  }
  if (input.status === 'active') where.push(sql`g.bot_status = 'member' AND g.disabled_at IS NULL`);
  if (input.status === 'disabled') where.push(sql`g.disabled_at IS NOT NULL`);
  if (input.status === 'removed') where.push(sql`g.bot_status = 'removed'`);
  if (input.platform) where.push(sql`gi.platform = ${input.platform}`);
  const condition = sql.join(where, sql` AND `);
  const order =
    input.sort === 'newest'
      ? sql`g.id DESC`
      : input.sort === 'members'
        ? sql`active_members DESC, members DESC, g.id DESC`
        : sql`last_activity DESC NULLS LAST, g.id DESC`;

  const rows = await queryRows<{
    id: number | string;
    title: string;
    is_sample: boolean;
    platform: Platform | null;
    chat_id: string | null;
    bot_status: 'member' | 'removed';
    disabled_at: Date | null;
    created_at: Date;
    city_level: number | null;
    bank: string | null;
    members: number;
    active_members: number;
    last_activity: Date | null;
    previous: number;
  }>(
    ctx.db,
    sql`SELECT g.id, g.title, g.is_sample, gi.platform, gi.platform_chat_id AS chat_id,
               g.bot_status, g.disabled_at, g.created_at, s.level AS city_level,
               w.balance::text AS bank, m.members, m.active_members, m.last_activity,
               (SELECT count(*)::int FROM group_identity_history gh WHERE gh.group_id = g.id) AS previous
        FROM groups g
        LEFT JOIN group_identities gi ON gi.group_id = g.id
        LEFT JOIN settlements s ON s.group_id = g.id
        LEFT JOIN wallets w ON w.group_id = g.id AND w.kind = 'group_blood_bank'
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE mm.status = 'member')::int AS members,
                 count(*) FILTER (WHERE mm.status = 'member'
                   AND mm.last_success_at >= ${since.toISOString()}::timestamptz)::int AS active_members,
                 max(mm.last_success_at) AS last_activity
          FROM memberships mm WHERE mm.group_id = g.id) m ON true
        WHERE ${condition}
        ORDER BY ${order}
        LIMIT ${input.limit} OFFSET ${input.offset}`,
  );
  const [count] = await queryRows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM groups g
        LEFT JOIN group_identities gi ON gi.group_id = g.id WHERE ${condition}`,
  );
  return {
    total: count?.n ?? 0,
    items: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      isSample: r.is_sample,
      platform: r.platform,
      chatId: r.chat_id,
      botPresent: r.bot_status === 'member',
      disabledAt: r.disabled_at === null ? null : new Date(r.disabled_at),
      createdAt: new Date(r.created_at),
      cityLevel: r.city_level ?? 1,
      bloodBankCenti: BigInt(r.bank ?? '0'),
      members: r.members ?? 0,
      activeMembers: r.active_members ?? 0,
      lastActivityAt: r.last_activity === null ? null : new Date(r.last_activity),
      previousChatIds: r.previous,
    })),
  };
}

export interface GroupMemberView {
  userId: number;
  displayName: string;
  status: 'member' | 'left';
  banned: boolean;
  joinedAt: Date;
  lastSuccessAt: Date | null;
  active: boolean;
}

export interface GroupMigrationView {
  id: number;
  platform: Platform;
  fromChatId: string;
  toChatId: string;
  groupId: number;
  groupTitle: string;
  status: 'migrated' | 'conflict';
  otherGroup: { id: number; title: string } | null;
  absorbedGroupId: number | null;
  detectedAt: Date;
  review: { at: Date; adminUsername: string; note: string | null } | null;
}

export interface AdminGroupDetail {
  group: {
    id: number;
    title: string;
    isSample: boolean;
    botPresent: boolean;
    botAddedAt: Date;
    botRemovedAt: Date | null;
    createdAt: Date;
    disabledAt: Date | null;
    disabledReason: string | null;
  };
  identity: { platform: Platform; chatId: string; since: Date } | null;
  previousChatIds: { platform: Platform; chatId: string; replacedAt: Date }[];
  city: CityView;
  members: { total: number; active: number; left: number; list: GroupMemberView[] };
  leaderboard: LeaderboardEntry[];
  migrations: GroupMigrationView[];
}

type MigrationRow = {
  id: number | string;
  platform: Platform;
  from_chat_id: string;
  to_chat_id: string;
  group_id: number | string;
  group_title: string | null;
  status: 'migrated' | 'conflict';
  other_group_id: number | string | null;
  other_title: string | null;
  absorbed_group_id: number | string | null;
  detected_at: Date;
  reviewed_at: Date | null;
  reviewer: string | null;
  review_note: string | null;
};

const migrationSelect = sql`
  SELECT gm.*, g.title AS group_title, o.title AS other_title, a.username AS reviewer
  FROM group_migrations gm
  LEFT JOIN groups g ON g.id = gm.group_id
  LEFT JOIN groups o ON o.id = gm.other_group_id
  LEFT JOIN admin_users a ON a.id = gm.reviewed_by_admin_id`;

const migrationView = (r: MigrationRow): GroupMigrationView => ({
  id: Number(r.id),
  platform: r.platform,
  fromChatId: r.from_chat_id,
  toChatId: r.to_chat_id,
  groupId: Number(r.group_id),
  groupTitle: r.group_title ?? '',
  status: r.status,
  otherGroup:
    r.other_group_id === null ? null : { id: Number(r.other_group_id), title: r.other_title ?? '' },
  absorbedGroupId: r.absorbed_group_id === null ? null : Number(r.absorbed_group_id),
  detectedAt: new Date(r.detected_at),
  review:
    r.reviewed_at === null
      ? null
      : { at: new Date(r.reviewed_at), adminUsername: r.reviewer ?? '', note: r.review_note },
});

const MEMBER_LIST_LIMIT = 200;

export async function adminGroupDetail(
  ctx: DomainContext,
  groupId: number,
): Promise<AdminGroupDetail | null> {
  const [g] = await ctx.db.select().from(groups).where(eq(groups.id, groupId));
  if (!g) return null;
  const now = ctx.clock.now();
  const { config } = await ctx.config.effectiveAt(ctx.db, now);
  const since = new Date(now.getTime() - config.city.activePopulationWindowDays * 86_400_000);

  const [identity] = await queryRows<{
    platform: Platform;
    platform_chat_id: string;
    updated_at: Date;
  }>(
    ctx.db,
    sql`SELECT platform, platform_chat_id, updated_at FROM group_identities WHERE group_id = ${groupId}`,
  );
  const history = await queryRows<{
    platform: Platform;
    platform_chat_id: string;
    replaced_at: Date;
  }>(
    ctx.db,
    sql`SELECT platform, platform_chat_id, replaced_at FROM group_identity_history
        WHERE group_id = ${groupId} ORDER BY replaced_at DESC`,
  );
  const [counts] = await queryRows<{ total: number; active: number; left: number }>(
    ctx.db,
    sql`SELECT count(*) FILTER (WHERE m.status = 'member')::int AS total,
               count(*) FILTER (WHERE m.status = 'member' AND u.banned_at IS NULL
                 AND m.last_success_at >= ${since.toISOString()}::timestamptz)::int AS active,
               count(*) FILTER (WHERE m.status = 'left')::int AS left
        FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.group_id = ${groupId}`,
  );
  const members = await queryRows<{
    user_id: number | string;
    display_name: string;
    status: 'member' | 'left';
    banned_at: Date | null;
    joined_at: Date;
    last_success_at: Date | null;
  }>(
    ctx.db,
    sql`SELECT m.user_id, u.display_name, m.status, u.banned_at, m.joined_at, m.last_success_at
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ${groupId}
        ORDER BY m.status, m.last_success_at DESC NULLS LAST, m.user_id
        LIMIT ${MEMBER_LIST_LIMIT}`,
  );
  const migrations = await queryRows<MigrationRow>(
    ctx.db,
    sql`${migrationSelect} WHERE gm.group_id = ${groupId} OR gm.other_group_id = ${groupId}
        ORDER BY gm.detected_at DESC, gm.id DESC`,
  );

  return {
    group: {
      id: g.id,
      title: g.title,
      isSample: g.isSample,
      botPresent: g.botStatus === 'member',
      botAddedAt: g.botAddedAt,
      botRemovedAt: g.botRemovedAt,
      createdAt: g.createdAt,
      disabledAt: g.disabledAt,
      disabledReason: g.disabledReason,
    },
    identity: identity
      ? {
          platform: identity.platform,
          chatId: identity.platform_chat_id,
          since: new Date(identity.updated_at),
        }
      : null,
    previousChatIds: history.map((h) => ({
      platform: h.platform,
      chatId: h.platform_chat_id,
      replacedAt: new Date(h.replaced_at),
    })),
    city: await cityView(ctx, groupId),
    members: {
      total: counts?.total ?? 0,
      active: counts?.active ?? 0,
      left: counts?.left ?? 0,
      list: members.map((m) => {
        const lastSuccessAt = m.last_success_at === null ? null : new Date(m.last_success_at);
        return {
          userId: Number(m.user_id),
          displayName: m.display_name,
          status: m.status,
          banned: m.banned_at !== null,
          joinedAt: new Date(m.joined_at),
          lastSuccessAt,
          active:
            m.status === 'member' &&
            m.banned_at === null &&
            lastSuccessAt !== null &&
            lastSuccessAt >= since,
        };
      }),
    },
    leaderboard: await scaryLeaderboard(ctx, { groupId, limit: 10 }),
    migrations: migrations.map(migrationView),
  };
}

export type SetGroupDisabledResult =
  | { status: 'ok' }
  | { status: 'unchanged' }
  | { status: 'not_found' }
  | { status: 'reason_required' };

/** Stops (or resumes) the bot in a group. The reason is required and audited. */
export async function setGroupDisabled(
  ctx: DomainContext,
  input: {
    groupId: number;
    disabled: boolean;
    reason: string;
    adminUserId: number;
    requestId?: string;
  },
): Promise<SetGroupDisabledResult> {
  const reason = input.reason.trim().slice(0, 500);
  if (reason === '') return { status: 'reason_required' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const [g] = await tx.select().from(groups).where(eq(groups.id, input.groupId)).for('update');
    if (!g) return { status: 'not_found' as const };
    if ((g.disabledAt !== null) === input.disabled) return { status: 'unchanged' as const };
    await tx
      .update(groups)
      .set(
        input.disabled
          ? { disabledAt: now, disabledReason: reason, disabledNoticeAt: null, updatedAt: now }
          : { disabledAt: null, disabledReason: null, disabledNoticeAt: null, updatedAt: now },
      )
      .where(eq(groups.id, input.groupId));
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: input.disabled ? 'group.disable' : 'group.enable',
      targetType: 'group',
      targetId: String(input.groupId),
      reason,
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return { status: 'ok' as const };
  });
}

export interface MigrationOverview {
  /** Conflicts nobody has reviewed yet, oldest first. */
  openConflicts: GroupMigrationView[];
  /** Every recorded migration, newest first (the last 100). */
  recent: GroupMigrationView[];
  /** Groups that changed chat id at least once, most changes first. */
  groupsWithPreviousIds: {
    groupId: number;
    title: string;
    platform: Platform | null;
    chatId: string | null;
    previous: { chatId: string; replacedAt: Date }[];
  }[];
}

export async function migrationOverview(ctx: DomainContext): Promise<MigrationOverview> {
  const open = await queryRows<MigrationRow>(
    ctx.db,
    sql`${migrationSelect} WHERE gm.status = 'conflict' AND gm.reviewed_at IS NULL
        ORDER BY gm.detected_at, gm.id`,
  );
  const recent = await queryRows<MigrationRow>(
    ctx.db,
    sql`${migrationSelect} ORDER BY gm.detected_at DESC, gm.id DESC LIMIT 100`,
  );
  const changed = await queryRows<{
    group_id: number | string;
    title: string;
    platform: Platform | null;
    chat_id: string | null;
    previous: { chatId: string; replacedAt: string }[];
  }>(
    ctx.db,
    sql`SELECT g.id AS group_id, g.title, gi.platform, gi.platform_chat_id AS chat_id,
               json_agg(json_build_object('chatId', gh.platform_chat_id, 'replacedAt', gh.replaced_at)
                        ORDER BY gh.replaced_at DESC) AS previous
        FROM group_identity_history gh
        JOIN groups g ON g.id = gh.group_id
        LEFT JOIN group_identities gi ON gi.group_id = g.id
        GROUP BY g.id, g.title, gi.platform, gi.platform_chat_id
        ORDER BY count(*) DESC, g.id
        LIMIT 200`,
  );
  return {
    openConflicts: open.map(migrationView),
    recent: recent.map(migrationView),
    groupsWithPreviousIds: changed.map((c) => ({
      groupId: Number(c.group_id),
      title: c.title,
      platform: c.platform,
      chatId: c.chat_id,
      previous: c.previous.map((p) => ({ chatId: p.chatId, replacedAt: new Date(p.replacedAt) })),
    })),
  };
}

/** Marks a migration conflict as looked at, with what was done about it. Audited. */
export async function reviewMigrationConflict(
  ctx: DomainContext,
  input: { migrationId: number; note: string; adminUserId: number; requestId?: string },
): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'note_required' }> {
  const note = input.note.trim().slice(0, 1000);
  if (note === '') return { status: 'note_required' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const updated = await tx
      .update(groupMigrations)
      .set({ reviewedAt: now, reviewedByAdminId: input.adminUserId, reviewNote: note })
      .where(
        and(
          eq(groupMigrations.id, input.migrationId),
          eq(groupMigrations.status, 'conflict'),
          isNull(groupMigrations.reviewedAt),
        ),
      )
      .returning({ id: groupMigrations.id });
    if (updated.length === 0) return { status: 'not_found' as const };
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'group_migration.review',
      targetType: 'group_migration',
      targetId: String(input.migrationId),
      reason: note,
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return { status: 'ok' as const };
  });
}
