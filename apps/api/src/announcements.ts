import type { Database, Executor, Platform } from '@lulu/database';
import { announcements, auditLogs, inTransaction, outbox, queryRows } from '@lulu/database';
import type { OutgoingMessage, PlatformId } from '@lulu/platform';
import { PLATFORM_CAPABILITIES } from '@lulu/platform';
import { OUTBOX_CHANNEL } from '@lulu/runtime';
import type { SQL } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Announcements from the panel to every group or to one group. Each recipient becomes an
 * ordinary outbox row, so the worker's sender applies the platform rate limits and
 * `retry_after` exactly as for game messages. The rows are spread out in time so a
 * large announcement never holds up the replies of the game itself.
 */

/** New announcement rows enter the queue at most this many per second. */
export const ANNOUNCEMENT_ROWS_PER_SECOND = 10;

export type AnnouncementTarget = { kind: 'all_groups' } | { kind: 'group'; groupId: number };

export interface Recipient {
  groupId: number;
  title: string;
  platform: Platform;
  chatId: string;
}

export interface RecipientSummary {
  recipients: Recipient[];
  /** Why groups were left out (only for «every group»). */
  skipped: { disabled: number; botRemoved: number; otherPlatform: number };
  /** Longest text every recipient platform accepts. */
  maxLength: number;
}

/** The longest text all enabled platforms can deliver in one message. */
export function maxAnnouncementLength(platforms: readonly PlatformId[]): number {
  return Math.min(...platforms.map((p) => PLATFORM_CAPABILITIES[p]?.maxTextLength ?? 4096));
}

/**
 * Who would receive it now: groups the bot is still in, on an enabled platform. «Every
 * group» leaves out groups an admin disabled; one chosen group is sent to even when
 * disabled, so the admin can tell its members why.
 */
export async function announcementRecipients(
  db: Executor,
  platforms: readonly PlatformId[],
  target: AnnouncementTarget,
): Promise<RecipientSummary | { status: 'group_not_found' }> {
  const scope: SQL = target.kind === 'group' ? sql`g.id = ${target.groupId}` : sql`true`;
  const rows = await queryRows<{
    group_id: string | number;
    title: string;
    platform: Platform | null;
    chat_id: string | null;
    bot_status: 'member' | 'removed';
    disabled: boolean;
  }>(
    db,
    sql`SELECT g.id AS group_id, g.title, gi.platform, gi.platform_chat_id AS chat_id,
               g.bot_status, g.disabled_at IS NOT NULL AS disabled
          FROM groups g
          LEFT JOIN group_identities gi ON gi.group_id = g.id
         WHERE ${scope}
         ORDER BY g.id, gi.platform`,
  );
  if (target.kind === 'group' && rows.length === 0) return { status: 'group_not_found' };
  const skipped = { disabled: 0, botRemoved: 0, otherPlatform: 0 };
  const recipients: Recipient[] = [];
  for (const r of rows) {
    if (r.bot_status !== 'member') skipped.botRemoved++;
    else if (r.platform === null || r.chat_id === null || !platforms.includes(r.platform)) {
      skipped.otherPlatform++;
    } else if (r.disabled && target.kind === 'all_groups') skipped.disabled++;
    else {
      recipients.push({
        groupId: Number(r.group_id),
        title: r.title,
        platform: r.platform,
        chatId: r.chat_id,
      });
    }
  }
  return { recipients, skipped, maxLength: maxAnnouncementLength(platforms) };
}

export type SendAnnouncementResult =
  | { status: 'ok'; id: number; recipients: number }
  | { status: 'empty_text' }
  | { status: 'too_long'; length: number; limit: number }
  | { status: 'no_recipients' }
  | { status: 'group_not_found' };

export async function sendAnnouncement(
  db: Database,
  input: {
    platforms: readonly PlatformId[];
    target: AnnouncementTarget;
    text: string;
    silent: boolean;
    adminUserId: number;
    requestId?: string;
    now: Date;
  },
): Promise<SendAnnouncementResult> {
  const text = input.text.trim();
  if (text === '') return { status: 'empty_text' };
  const limit = maxAnnouncementLength(input.platforms);
  if (text.length > limit) return { status: 'too_long', length: text.length, limit };

  return inTransaction(db, async (tx) => {
    const found = await announcementRecipients(tx, input.platforms, input.target);
    if ('status' in found) return found;
    if (found.recipients.length === 0) return { status: 'no_recipients' as const };
    const [row] = await tx
      .insert(announcements)
      .values({
        text,
        target: input.target.kind,
        groupId: input.target.kind === 'group' ? input.target.groupId : null,
        silent: input.silent,
        recipients: found.recipients.length,
        createdByAdminId: input.adminUserId,
        createdAt: input.now,
      })
      .returning({ id: announcements.id });
    const id = row!.id;
    const start = input.now.getTime();
    // Inserted in slices: one statement per thousand groups keeps parameters bounded.
    for (let from = 0; from < found.recipients.length; from += 1000) {
      await tx.insert(outbox).values(
        found.recipients.slice(from, from + 1000).map((r, k) => {
          const i = from + k;
          const payload: OutgoingMessage = {
            platformChatId: r.chatId,
            text,
            format: 'plain',
            ...(input.silent ? { silent: true } : {}),
          };
          return {
            platform: r.platform,
            kind: 'send' as const,
            payload,
            dedupeKey: `announcement:${id}:${r.platform}:${r.chatId}`,
            announcementId: id,
            createdAt: input.now,
            nextAttemptAt: new Date(start + Math.floor(i / ANNOUNCEMENT_ROWS_PER_SECOND) * 1000),
          };
        }),
      );
    }
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'announcement.send',
      targetType: input.target.kind === 'group' ? 'group' : 'announcement',
      targetId: String(input.target.kind === 'group' ? input.target.groupId : id),
      details: { announcementId: id, recipients: found.recipients.length, silent: input.silent },
      requestId: input.requestId ?? null,
      createdAt: input.now,
    });
    await tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
    return { status: 'ok' as const, id, recipients: found.recipients.length };
  });
}

export interface DeliveryCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface AnnouncementSummary {
  id: number;
  /** Untrusted only in the sense of being admin-written; shown as plain text. */
  text: string;
  target: 'all_groups' | 'group';
  group: { id: number; title: string } | null;
  silent: boolean;
  createdBy: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  counts: DeliveryCounts;
  lastSentAt: Date | null;
}

interface SummaryRow {
  id: string | number;
  text: string;
  target: 'all_groups' | 'group';
  group_id: string | number | null;
  group_title: string | null;
  silent: boolean;
  created_by: string | null;
  created_at: Date | string;
  cancelled_at: Date | string | null;
  cancelled_by: string | null;
  total: number;
  pending: number;
  sent: number;
  failed: number;
  cancelled: number;
  last_sent_at: Date | string | null;
}

const summarySelect = sql`
  SELECT a.id, a.text, a.target, a.group_id, g.title AS group_title, a.silent,
         cu.username AS created_by, a.created_at, a.cancelled_at, xu.username AS cancelled_by,
         count(o.id)::int AS total,
         count(o.id) FILTER (WHERE o.status = 'pending')::int AS pending,
         count(o.id) FILTER (WHERE o.status = 'sent')::int AS sent,
         count(o.id) FILTER (WHERE o.status = 'dead')::int AS failed,
         count(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
         max(o.sent_at) AS last_sent_at
    FROM announcements a
    LEFT JOIN groups g ON g.id = a.group_id
    LEFT JOIN admin_users cu ON cu.id = a.created_by_admin_id
    LEFT JOIN admin_users xu ON xu.id = a.cancelled_by_admin_id
    LEFT JOIN outbox o ON o.announcement_id = a.id`;

const when = (v: Date | string | null) => (v === null ? null : new Date(v));

const summary = (r: SummaryRow): AnnouncementSummary => ({
  id: Number(r.id),
  text: r.text,
  target: r.target,
  group: r.group_id !== null ? { id: Number(r.group_id), title: r.group_title ?? '' } : null,
  silent: r.silent,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  cancelledAt: when(r.cancelled_at),
  cancelledBy: r.cancelled_by,
  counts: {
    total: r.total,
    pending: r.pending,
    sent: r.sent,
    failed: r.failed,
    cancelled: r.cancelled,
  },
  lastSentAt: when(r.last_sent_at),
});

export async function listAnnouncements(
  db: Database,
  input: { limit: number; offset: number },
): Promise<{ items: AnnouncementSummary[]; total: number }> {
  const rows = await queryRows<SummaryRow>(
    db,
    sql`${summarySelect} GROUP BY a.id, g.title, cu.username, xu.username
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${input.limit} OFFSET ${input.offset}`,
  );
  const [count] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM announcements`,
  );
  return { items: rows.map(summary), total: count?.n ?? 0 };
}

export interface AnnouncementDetail extends AnnouncementSummary {
  /** Failed first, then waiting, then the rest. */
  deliveries: {
    groupId: number | null;
    title: string | null;
    platform: Platform;
    chatId: string;
    status: 'pending' | 'sent' | 'dead' | 'cancelled';
    attempts: number;
    lastError: string | null;
    sentAt: Date | null;
    nextAttemptAt: Date;
  }[];
}

export async function announcementDetail(
  db: Database,
  id: number,
): Promise<AnnouncementDetail | null> {
  const [row] = await queryRows<SummaryRow>(
    db,
    sql`${summarySelect} WHERE a.id = ${id} GROUP BY a.id, g.title, cu.username, xu.username`,
  );
  if (!row) return null;
  // The chat id may have changed since (supergroup migration): resolve old ids too.
  const deliveries = await queryRows<{
    group_id: string | number | null;
    title: string | null;
    platform: Platform;
    chat_id: string;
    status: AnnouncementDetail['deliveries'][number]['status'];
    attempts: number;
    last_error: string | null;
    sent_at: Date | string | null;
    next_attempt_at: Date | string;
  }>(
    db,
    sql`SELECT k.group_id, g.title, o.platform, o.payload->>'platformChatId' AS chat_id,
               o.status, o.attempts, o.last_error, o.sent_at, o.next_attempt_at
          FROM outbox o
          LEFT JOIN LATERAL (
            SELECT group_id FROM group_identities gi
             WHERE gi.platform = o.platform AND gi.platform_chat_id = o.payload->>'platformChatId'
            UNION ALL
            SELECT group_id FROM group_identity_history gh
             WHERE gh.platform = o.platform AND gh.platform_chat_id = o.payload->>'platformChatId'
            LIMIT 1) k ON true
          LEFT JOIN groups g ON g.id = k.group_id
         WHERE o.announcement_id = ${id}
         ORDER BY CASE o.status WHEN 'dead' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id
         LIMIT 2000`,
  );
  return {
    ...summary(row),
    deliveries: deliveries.map((d) => ({
      groupId: d.group_id === null ? null : Number(d.group_id),
      title: d.title,
      platform: d.platform,
      chatId: d.chat_id,
      status: d.status,
      attempts: d.attempts,
      lastError: d.last_error,
      sentAt: when(d.sent_at),
      nextAttemptAt: new Date(d.next_attempt_at),
    })),
  };
}

export type CancelAnnouncementResult =
  { status: 'ok'; cancelled: number } | { status: 'not_found' } | { status: 'nothing_pending' };

/**
 * Takes every message of the announcement that is still waiting out of the queue. A
 * message the sender is delivering at this very moment may still arrive.
 */
export async function cancelAnnouncement(
  db: Database,
  input: { id: number; adminUserId: number; requestId?: string; now: Date },
): Promise<CancelAnnouncementResult> {
  return inTransaction(db, async (tx) => {
    const [a] = await tx
      .select({ id: announcements.id })
      .from(announcements)
      .where(eq(announcements.id, input.id))
      .for('update');
    if (!a) return { status: 'not_found' as const };
    const rows = await tx
      .update(outbox)
      .set({ status: 'cancelled', lastError: null })
      .where(and(eq(outbox.announcementId, input.id), eq(outbox.status, 'pending')))
      .returning({ id: outbox.id });
    if (rows.length === 0) return { status: 'nothing_pending' as const };
    await tx
      .update(announcements)
      .set({ cancelledAt: input.now, cancelledByAdminId: input.adminUserId })
      .where(eq(announcements.id, input.id));
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'announcement.cancel',
      targetType: 'announcement',
      targetId: String(input.id),
      details: { cancelled: rows.length },
      requestId: input.requestId ?? null,
      createdAt: input.now,
    });
    return { status: 'ok' as const, cancelled: rows.length };
  });
}

export type RetryAnnouncementResult =
  { status: 'ok'; retried: number } | { status: 'not_found' } | { status: 'nothing_failed' };

/** Puts the failed messages of an announcement back in the queue with fresh attempts. */
export async function retryAnnouncementFailures(
  db: Database,
  input: { id: number; adminUserId: number; requestId?: string; now: Date },
): Promise<RetryAnnouncementResult> {
  return inTransaction(db, async (tx) => {
    const [a] = await tx
      .select({ id: announcements.id })
      .from(announcements)
      .where(eq(announcements.id, input.id))
      .for('update');
    if (!a) return { status: 'not_found' as const };
    const rows = await tx
      .update(outbox)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: input.now })
      .where(and(eq(outbox.announcementId, input.id), eq(outbox.status, 'dead')))
      .returning({ id: outbox.id });
    if (rows.length === 0) return { status: 'nothing_failed' as const };
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'announcement.retry',
      targetType: 'announcement',
      targetId: String(input.id),
      details: { retried: rows.length },
      requestId: input.requestId ?? null,
      createdAt: input.now,
    });
    await tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
    return { status: 'ok' as const, retried: rows.length };
  });
}
