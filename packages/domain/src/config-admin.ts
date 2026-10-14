import type { ConfigChange, ConfigIssue, GameConfig } from '@lulu/config';
import { configIssues, diffConfig, parseGameConfig, requiresOwnerApproval } from '@lulu/config';
import { auditLogs, configVersions, inTransaction, queryRows } from '@lulu/database';
import { desc, eq, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { lockKey } from './players.ts';

/**
 * Economy settings from the admin panel. Every save is a new config version effective at
 * once; nothing is edited in place, so a rollback is just a new version with an older
 * document. Changes to owner rules (`fixed`) need the owner's approval (the API checks
 * the role and the re-entered password and passes `ownerApproved`). A save is refused
 * when another version was saved after the one the admin started from.
 */

export interface ConfigVersionInfo {
  id: number;
  source: 'default' | 'panel';
  note: string;
  effectiveFrom: Date;
  createdAt: Date;
  createdBy: string | null;
  ownerApprovedBy: string | null;
}

export async function currentConfig(
  ctx: DomainContext,
): Promise<{ versionId: number; config: GameConfig; info: ConfigVersionInfo }> {
  const now = ctx.clock.now();
  const { versionId, config } = await ctx.config.effectiveAt(ctx.db, now);
  const [info] = await versionRows(ctx, sql`v.id = ${versionId}`, 1);
  return { versionId, config, info: info! };
}

export type PreviewResult =
  | { status: 'invalid'; issues: ConfigIssue[] }
  | { status: 'ok'; baseVersionId: number; changes: ConfigChange[]; needsOwner: boolean };

/** What saving `input` would change, without saving anything. */
export async function previewConfigChange(
  ctx: DomainContext,
  input: unknown,
): Promise<PreviewResult> {
  const issues = configIssues(input);
  if (issues.length) return { status: 'invalid', issues };
  const next = parseGameConfig(input);
  const { versionId, config } = await ctx.config.effectiveAt(ctx.db, ctx.clock.now());
  const changes = diffConfig(config, next);
  return {
    status: 'ok',
    baseVersionId: versionId,
    changes,
    needsOwner: requiresOwnerApproval(changes),
  };
}

export type SaveConfigResult =
  | { status: 'ok'; versionId: number; changes: ConfigChange[] }
  | { status: 'invalid'; issues: ConfigIssue[] }
  | { status: 'note_required' }
  | { status: 'unchanged' }
  | { status: 'stale'; currentVersionId: number }
  | { status: 'needs_owner'; changes: ConfigChange[] };

export async function saveConfigVersion(
  ctx: DomainContext,
  input: {
    config: unknown;
    note: string;
    /** The version the admin edited; another save in between makes this one stale. */
    baseVersionId: number;
    adminUserId: number;
    /** The owner approved (role and password checked by the caller). */
    ownerApproved: boolean;
    requestId?: string;
    /** Set when restoring an older version. */
    rollbackOf?: number;
  },
): Promise<SaveConfigResult> {
  const note = input.note.trim().slice(0, 500);
  if (note === '') return { status: 'note_required' };
  const issues = configIssues(input.config);
  if (issues.length) return { status: 'invalid', issues };
  const next = parseGameConfig(input.config);
  const now = ctx.clock.now();

  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, 'config-versions');
    const current = await ctx.config.effectiveAt(tx, now);
    if (current.versionId !== input.baseVersionId) {
      return { status: 'stale' as const, currentVersionId: current.versionId };
    }
    const changes = diffConfig(current.config, next);
    if (changes.length === 0) return { status: 'unchanged' as const };
    const needsOwner = requiresOwnerApproval(changes);
    if (needsOwner && !input.ownerApproved) return { status: 'needs_owner' as const, changes };

    const [row] = await tx
      .insert(configVersions)
      .values({
        config: next,
        source: 'panel',
        note,
        effectiveFrom: now,
        createdAt: now,
        createdByAdminId: input.adminUserId,
        ownerApprovedByAdminId: needsOwner ? input.adminUserId : null,
      })
      .returning({ id: configVersions.id });
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: input.rollbackOf !== undefined ? 'config.rollback' : 'config.update',
      targetType: 'config_version',
      targetId: String(row!.id),
      reason: note,
      details: {
        previousVersionId: current.versionId,
        ...(input.rollbackOf !== undefined ? { restoredVersionId: input.rollbackOf } : {}),
        ownerRules: needsOwner,
        changes: changes.map((c) => ({
          path: c.path,
          label: c.label,
          before: c.before,
          after: c.after,
        })),
      },
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return { status: 'ok' as const, versionId: row!.id, changes };
  });
}

async function versionRows(ctx: DomainContext, where: ReturnType<typeof sql>, limit: number) {
  const rows = await queryRows<{
    id: number | string;
    source: 'default' | 'panel';
    note: string;
    effective_from: Date;
    created_at: Date;
    created_by: string | null;
    approved_by: string | null;
  }>(
    ctx.db,
    sql`SELECT v.id, v.source, v.note, v.effective_from, v.created_at,
               c.username AS created_by, o.username AS approved_by
        FROM config_versions v
        LEFT JOIN admin_users c ON c.id = v.created_by_admin_id
        LEFT JOIN admin_users o ON o.id = v.owner_approved_by_admin_id
        WHERE ${where}
        ORDER BY v.effective_from DESC, v.id DESC
        LIMIT ${limit}`,
  );
  return rows.map((r): ConfigVersionInfo => ({
    id: Number(r.id),
    source: r.source,
    note: r.note,
    effectiveFrom: new Date(r.effective_from),
    createdAt: new Date(r.created_at),
    createdBy: r.created_by,
    ownerApprovedBy: r.approved_by,
  }));
}

/** The version before `version` in effect order, if any. */
async function previousOf(ctx: DomainContext, version: { id: number; effectiveFrom: Date }) {
  const [prev] = await ctx.db
    .select({ id: configVersions.id, config: configVersions.config })
    .from(configVersions)
    .where(
      sql`(${configVersions.effectiveFrom}, ${configVersions.id}) < (${version.effectiveFrom.toISOString()}::timestamptz, ${version.id})`,
    )
    .orderBy(desc(configVersions.effectiveFrom), desc(configVersions.id))
    .limit(1);
  return prev;
}

export interface ConfigVersionSummary extends ConfigVersionInfo {
  /** Leaves changed compared with the version before it. */
  changeCount: number;
  ownerRulesChanged: boolean;
  /** In force right now. */
  current: boolean;
}

/** Newest first, with how much each one changed. */
export async function listConfigVersions(
  ctx: DomainContext,
  limit = 50,
): Promise<ConfigVersionSummary[]> {
  const now = ctx.clock.now();
  const { versionId: currentId } = await ctx.config.effectiveAt(ctx.db, now);
  const infos = await versionRows(ctx, sql`true`, limit + 1);
  const docs = await ctx.db
    .select({ id: configVersions.id, config: configVersions.config })
    .from(configVersions)
    .where(
      infos.length
        ? sql`${configVersions.id} IN (${sql.join(
            infos.map((i) => sql`${i.id}`),
            sql`, `,
          )})`
        : sql`false`,
    );
  const parsed = new Map(docs.map((d) => [d.id, parseGameConfig(d.config)]));
  return infos.slice(0, limit).map((info, i) => {
    const before = infos[i + 1];
    const changes =
      before && parsed.get(before.id)
        ? diffConfig(parsed.get(before.id)!, parsed.get(info.id)!)
        : [];
    return {
      ...info,
      changeCount: changes.length,
      ownerRulesChanged: requiresOwnerApproval(changes),
      current: info.id === currentId,
    };
  });
}

/** One version's document and what it changed compared with the version before it. */
export async function configVersionDetail(
  ctx: DomainContext,
  id: number,
): Promise<{ info: ConfigVersionInfo; config: GameConfig; changes: ConfigChange[] } | null> {
  const [info] = await versionRows(ctx, sql`v.id = ${id}`, 1);
  if (!info) return null;
  const [row] = await ctx.db
    .select({ config: configVersions.config })
    .from(configVersions)
    .where(eq(configVersions.id, id));
  const config = parseGameConfig(row!.config);
  const prev = await previousOf(ctx, info);
  return { info, config, changes: prev ? diffConfig(parseGameConfig(prev.config), config) : [] };
}

/** Restores an older version as a new one (history is never rewritten). */
export async function rollbackConfig(
  ctx: DomainContext,
  input: {
    versionId: number;
    note: string;
    baseVersionId: number;
    adminUserId: number;
    ownerApproved: boolean;
    requestId?: string;
  },
): Promise<SaveConfigResult | { status: 'not_found' }> {
  const [row] = await ctx.db
    .select({ config: configVersions.config })
    .from(configVersions)
    .where(eq(configVersions.id, input.versionId));
  if (!row) return { status: 'not_found' };
  return saveConfigVersion(ctx, {
    config: row.config,
    note: input.note,
    baseVersionId: input.baseVersionId,
    adminUserId: input.adminUserId,
    ownerApproved: input.ownerApproved,
    rollbackOf: input.versionId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
}
