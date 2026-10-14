import type { Database } from '@lulu/database';
import { queryRows } from '@lulu/database';
import { addDays, tehranMidnight } from '@lulu/domain';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * The audit log for the panel: every admin action (and the few system ones), newest
 * first, filtered by admin, action, target and Tehran day, with free-text search over
 * the reason, details, target id and request id.
 */

export interface AuditFilter {
  /** An admin's id, or `system` for entries without an admin. */
  actor?: number | 'system';
  action?: string;
  targetType?: string;
  targetId?: string;
  fromDay?: string;
  toDay?: string;
  query?: string;
}

export interface AuditEntry {
  id: number;
  createdAt: Date;
  actor: 'admin' | 'system';
  admin: { id: number; username: string } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** The target's current name (group title, player name, admin username), when known. */
  targetName: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  requestId: string | null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function conditions(f: AuditFilter): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.actor === 'system') parts.push(sql`a.admin_user_id IS NULL`);
  else if (f.actor !== undefined) parts.push(sql`a.admin_user_id = ${f.actor}`);
  if (f.action) parts.push(sql`a.action = ${f.action}`);
  if (f.targetType) parts.push(sql`a.target_type = ${f.targetType}`);
  if (f.targetId) parts.push(sql`a.target_id = ${f.targetId}`);
  if (f.fromDay) {
    parts.push(sql`a.created_at >= ${tehranMidnight(f.fromDay).toISOString()}::timestamptz`);
  }
  if (f.toDay) {
    const end = tehranMidnight(addDays(f.toDay, 1)).toISOString();
    parts.push(sql`a.created_at < ${end}::timestamptz`);
  }
  const q = f.query?.trim();
  if (q) {
    const like = `%${likeEscape(q)}%`;
    parts.push(sql`(a.reason ILIKE ${like} OR a.details::text ILIKE ${like}
                    OR a.request_id ILIKE ${like} OR a.target_id = ${q} OR a.action ILIKE ${like})`);
  }
  return sql.join(parts, sql` AND `);
}

export async function searchAudit(
  db: Database,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): Promise<{ items: AuditEntry[]; total: number }> {
  const where = conditions(filter);
  const rows = await queryRows<{
    id: string | number;
    created_at: Date | string;
    actor: 'admin' | 'system';
    admin_id: string | number | null;
    admin_username: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    target_name: string | null;
    reason: string | null;
    details: Record<string, unknown> | null;
    request_id: string | null;
  }>(
    db,
    sql`SELECT a.id, a.created_at, a.actor, a.admin_user_id AS admin_id, au.username AS admin_username,
               a.action, a.target_type, a.target_id, a.reason, a.details, a.request_id,
               CASE a.target_type
                 WHEN 'group' THEN (SELECT g.title FROM groups g WHERE g.id::text = a.target_id)
                 WHEN 'user' THEN (SELECT u.display_name FROM users u WHERE u.id::text = a.target_id)
                 WHEN 'admin_user' THEN (SELECT t.username FROM admin_users t WHERE t.id::text = a.target_id)
               END AS target_name
          FROM audit_logs a
          LEFT JOIN admin_users au ON au.id = a.admin_user_id
         WHERE ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`,
  );
  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      createdAt: new Date(r.created_at),
      actor: r.actor,
      admin:
        r.admin_id !== null ? { id: Number(r.admin_id), username: r.admin_username ?? '' } : null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      targetName: r.target_name,
      reason: r.reason,
      details: r.details ?? {},
      requestId: r.request_id,
    })),
    total: count?.n ?? 0,
  };
}

/** Values for the filter menus: every admin and every action that was ever recorded. */
export async function auditFilterOptions(db: Database): Promise<{
  admins: { id: number; username: string }[];
  actions: string[];
  targetTypes: string[];
}> {
  const admins = await queryRows<{ id: string | number; username: string }>(
    db,
    sql`SELECT id, username FROM admin_users ORDER BY username`,
  );
  const actions = await queryRows<{ action: string }>(
    db,
    sql`SELECT DISTINCT action FROM audit_logs ORDER BY action`,
  );
  const targets = await queryRows<{ target_type: string }>(
    db,
    sql`SELECT DISTINCT target_type FROM audit_logs WHERE target_type IS NOT NULL ORDER BY target_type`,
  );
  return {
    admins: admins.map((a) => ({ id: Number(a.id), username: a.username })),
    actions: actions.map((a) => a.action),
    targetTypes: targets.map((t) => t.target_type),
  };
}
