import { createHash } from 'node:crypto';
import { GAME_TIME_ZONE } from '@lulu/config';
import type { PlatformId } from '@lulu/platform';
import { maxGhostStoryLength } from '@lulu/platform';
import { auditLogs, ghostBatches, inTransaction, queryRows } from '@lulu/database';
import type { SQL } from 'drizzle-orm';
import { eq, like, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { activateDueBatches, ghostContentStatus, importGhostBatch } from './ghost-batches.ts';
import { lockKey } from './players.ts';
import { addDays, isValidDate, tehranDate } from './tehran.ts';

/**
 * Ghost content for the admin panel: the nightly batches (upcoming, live and past), the
 * days ahead that still have no batch, and the panel's own import form. The form goes
 * through `importGhostBatch`, so it obeys exactly the rules of the file importer: an
 * incomplete batch is refused as a whole and never touches the live one.
 */

export type GhostBatchStatus = 'scheduled' | 'active' | 'retired' | 'cancelled';

export interface GhostBatchSummary {
  id: number;
  batchId: string;
  activeDate: string;
  status: GhostBatchStatus;
  isSample: boolean;
  source: 'file' | 'panel' | 'dev_seed';
  importedAt: Date;
  /** Username of the admin who added it from the panel. */
  importedBy: string | null;
  activatedAt: Date | null;
  /** When it left live selection (retired) or was cancelled. */
  retiredAt: Date | null;
  /** Ghosts found with its texts, and how many of them were answered with «شنیدم». */
  encounters: number;
  heard: number;
}

export interface GhostLimits {
  batchSize: number;
  maxStoryLength: number;
  /** The enabled platform whose message limit sets `maxStoryLength`. */
  decidedBy: PlatformId;
}

export interface GhostOverview extends GhostCoverage {
  limits: GhostLimits;
  active: GhostBatchSummary | null;
  /** Waiting batches, soonest first. */
  upcoming: GhostBatchSummary[];
  /** Retired and cancelled batches, newest first (the last `PAST_LIMIT`). */
  past: GhostBatchSummary[];
  pastTotal: number;
}

const PAST_LIMIT = 60;

interface BatchRow {
  id: string | number;
  batch_key: string;
  active_date: string;
  status: GhostBatchStatus;
  is_sample: boolean;
  source: GhostBatchSummary['source'];
  imported_at: Date | string;
  imported_by: string | null;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
  encounters: number;
  heard: number;
}

const batchSelect = sql`
  SELECT gb.id, gb.batch_key, gb.active_date::text AS active_date, gb.status, gb.is_sample,
         gb.source, gb.imported_at, au.username AS imported_by, gb.activated_at, gb.retired_at,
         COALESCE(e.encounters, 0)::int AS encounters, COALESCE(e.heard, 0)::int AS heard
    FROM ghost_batches gb
    LEFT JOIN admin_users au ON au.id = gb.imported_by_admin_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS encounters, count(ge.heard_at) AS heard
        FROM ghost_stories gs
        JOIN ghost_encounters ge ON ge.story_id = gs.id
       WHERE gs.batch_id = gb.id
    ) e ON true`;

const date = (v: Date | string | null) => (v === null ? null : new Date(v));

const summary = (r: BatchRow): GhostBatchSummary => ({
  id: Number(r.id),
  batchId: r.batch_key,
  activeDate: r.active_date,
  status: r.status,
  isSample: r.is_sample,
  source: r.source,
  importedAt: new Date(r.imported_at),
  importedBy: r.imported_by,
  activatedAt: date(r.activated_at),
  retiredAt: date(r.retired_at),
  encounters: r.encounters,
  heard: r.heard,
});

async function batches(ctx: DomainContext, where: SQL, order: SQL, limit?: number) {
  const rows = await queryRows<BatchRow>(
    ctx.db,
    sql`${batchSelect} WHERE ${where} ORDER BY ${order}${limit ? sql` LIMIT ${limit}` : sql``}`,
  );
  return rows.map(summary);
}

export async function ghostLimits(ctx: DomainContext): Promise<GhostLimits> {
  const { config } = await ctx.config.effectiveAt(ctx.db, ctx.clock.now());
  const { limit, decidedBy } = maxGhostStoryLength(ctx.platforms);
  return { batchSize: config.ghosts.batchSize, maxStoryLength: limit, decidedBy };
}

export interface GhostCoverage {
  today: string;
  lookaheadDays: number;
  /** Tehran days from tomorrow to `lookaheadDays` ahead with no batch waiting. */
  missingDates: string[];
  /** No live batch at all, or the live one is older than today. */
  warning: 'no_active_batch' | 'stale_batch' | null;
}

/** Whether the coming nights have content; shown on the ghost page and the dashboard. */
export async function ghostCoverage(ctx: DomainContext): Promise<GhostCoverage> {
  const { config } = await ctx.config.effectiveAt(ctx.db, ctx.clock.now());
  const status = await ghostContentStatus(ctx);
  const lookaheadDays = config.monitoring.ghostLookaheadDays;
  const ahead = Array.from({ length: lookaheadDays }, (_, i) => addDays(status.today, i + 1));
  const waiting = await queryRows<{ day: string }>(
    ctx.db,
    sql`SELECT active_date::text AS day FROM ghost_batches
         WHERE status = 'scheduled' AND active_date BETWEEN ${ahead[0]!} AND ${ahead.at(-1)!}`,
  );
  const taken = new Set(waiting.map((w) => w.day));
  return {
    today: status.today,
    lookaheadDays,
    missingDates: ahead.filter((d) => !taken.has(d)),
    warning: status.warning,
  };
}

export async function ghostOverview(ctx: DomainContext): Promise<GhostOverview> {
  const coverage = await ghostCoverage(ctx);
  const [active] = await batches(ctx, sql`gb.status = 'active'`, sql`gb.id`);
  const upcoming = await batches(ctx, sql`gb.status = 'scheduled'`, sql`gb.active_date, gb.id`);
  const past = await batches(
    ctx,
    sql`gb.status IN ('retired', 'cancelled')`,
    sql`gb.active_date DESC, gb.id DESC`,
    PAST_LIMIT,
  );
  const [count] = await queryRows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM ghost_batches WHERE status IN ('retired', 'cancelled')`,
  );
  return {
    ...coverage,
    limits: await ghostLimits(ctx),
    active: active ?? null,
    upcoming,
    past,
    pastTotal: count?.n ?? 0,
  };
}

export interface GhostBatchDetail {
  batch: GhostBatchSummary;
  stories: {
    position: number;
    storyKey: string;
    /** Untrusted display text. */
    text: string;
    encounters: number;
    heard: number;
  }[];
  /** Who cancelled it and why (from the audit log), for a cancelled batch. */
  cancellation: { by: string | null; reason: string | null; at: Date } | null;
}

export async function ghostBatchDetail(
  ctx: DomainContext,
  id: number,
): Promise<GhostBatchDetail | null> {
  const [batch] = await batches(ctx, sql`gb.id = ${id}`, sql`gb.id`);
  if (!batch) return null;
  const stories = await queryRows<{
    position: number;
    story_key: string;
    text: string;
    encounters: number;
    heard: number;
  }>(
    ctx.db,
    sql`SELECT gs.position, gs.story_key, gs.text,
               count(ge.id)::int AS encounters, count(ge.heard_at)::int AS heard
          FROM ghost_stories gs
          LEFT JOIN ghost_encounters ge ON ge.story_id = gs.id
         WHERE gs.batch_id = ${id}
         GROUP BY gs.id
         ORDER BY gs.position`,
  );
  const [cancel] =
    batch.status === 'cancelled'
      ? await queryRows<{ username: string | null; reason: string | null; created_at: Date }>(
          ctx.db,
          sql`SELECT au.username, al.reason, al.created_at
                FROM audit_logs al LEFT JOIN admin_users au ON au.id = al.admin_user_id
               WHERE al.action = 'ghost.cancel' AND al.target_type = 'ghost_batch'
                 AND al.target_id = ${String(id)}
               ORDER BY al.id DESC LIMIT 1`,
        )
      : [];
  return {
    batch,
    stories: stories.map((s) => ({
      position: s.position,
      storyKey: s.story_key,
      text: s.text,
      encounters: s.encounters,
      heard: s.heard,
    })),
    cancellation: cancel
      ? { by: cancel.username, reason: cancel.reason, at: new Date(cancel.created_at) }
      : null,
  };
}

/** Why one text of the panel form was refused. */
export type GhostTextIssue =
  | { code: 'empty' }
  | { code: 'too_long'; length: number; limit: number; decidedBy: PlatformId }
  /** Same text as an earlier one in the form (0-based index). */
  | { code: 'duplicate'; of: number };

export type PanelGhostImportResult =
  | { status: 'imported'; id: number; batchId: string; activeDate: string; live: boolean }
  /** The very same texts for the same day were added before; nothing changed. */
  | { status: 'already_imported'; batchId: string }
  | {
      status: 'invalid';
      activeDate: 'invalid' | 'in_past' | null;
      /** One entry per form text, `null` when that text is fine. */
      texts: (GhostTextIssue | null)[];
      /** The form did not have exactly `batchSize` texts. */
      wrongCount: { expected: number; got: number } | null;
    }
  | { status: 'conflict'; reason: 'date_taken' | 'different_content' | 'date_in_past' };

/**
 * The panel form: one Tehran date and exactly `batchSize` texts. The batch id is derived
 * from the date and the texts, so sending the same form twice adds it once. A batch for
 * today goes live at once (as the file importer does); a later one waits for its night.
 */
export async function importPanelGhostBatch(
  ctx: DomainContext,
  input: { activeDate: string; texts: string[]; adminUserId: number; requestId?: string },
): Promise<PanelGhostImportResult> {
  const limits = await ghostLimits(ctx);
  const today = tehranDate(ctx.clock.now());
  const texts = input.texts.map((t) => t.trim());
  const activeDate = !isValidDate(input.activeDate)
    ? ('invalid' as const)
    : input.activeDate < today
      ? ('in_past' as const)
      : null;
  const issues = texts.map((text, i): GhostTextIssue | null => {
    if (text === '') return { code: 'empty' };
    if (text.length > limits.maxStoryLength) {
      return {
        code: 'too_long',
        length: text.length,
        limit: limits.maxStoryLength,
        decidedBy: limits.decidedBy,
      };
    }
    const first = texts.indexOf(text);
    return first < i ? { code: 'duplicate', of: first } : null;
  });
  const wrongCount =
    texts.length === limits.batchSize ? null : { expected: limits.batchSize, got: texts.length };
  if (activeDate || wrongCount || issues.some((x) => x !== null)) {
    return { status: 'invalid', activeDate, texts: issues, wrongCount };
  }

  const hash = createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 12);
  const base = `panel-${input.activeDate}-${hash}`;
  // The same texts again after cancelling them need a new id; otherwise it is a repeat.
  const earlier = await ctx.db
    .select({ key: ghostBatches.batchKey, status: ghostBatches.status })
    .from(ghostBatches)
    .where(like(ghostBatches.batchKey, `${base}%`));
  const kept = earlier.find((b) => b.status !== 'cancelled');
  const batchId = kept?.key ?? (earlier.length === 0 ? base : `${base}-${earlier.length + 1}`);
  const result = await importGhostBatch(
    ctx,
    {
      batchId,
      activeDate: input.activeDate,
      timezone: GAME_TIME_ZONE,
      stories: texts.map((text, i) => ({ id: `${batchId}-s${i + 1}`, text })),
    },
    {
      source: 'panel',
      adminUserId: input.adminUserId,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    },
  );
  switch (result.status) {
    case 'imported': {
      const live = result.activeDate <= today;
      if (live) await activateDueBatches(ctx);
      const [row] = await ctx.db
        .select({ id: ghostBatches.id })
        .from(ghostBatches)
        .where(eq(ghostBatches.batchKey, batchId));
      return { status: 'imported', id: row!.id, batchId, activeDate: result.activeDate, live };
    }
    case 'already_imported':
      return result;
    case 'conflict':
      return result;
    case 'invalid':
      // Every rule importGhostBatch checks was checked above; reaching here is a bug.
      throw new Error(`panel ghost batch refused: ${result.errors.join('; ')}`);
  }
}

export type CancelGhostBatchResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'not_scheduled' }
  | { status: 'reason_required' };

/**
 * Takes a waiting batch out of the queue, so a mistake can be fixed by adding a new batch
 * for the same night. A live or past batch cannot be cancelled: players may have found
 * its ghosts, and those encounters stay valid.
 */
export async function cancelGhostBatch(
  ctx: DomainContext,
  input: { id: number; reason: string; adminUserId: number; requestId?: string },
): Promise<CancelGhostBatchResult> {
  const reason = input.reason.trim().slice(0, 500);
  if (reason === '') return { status: 'reason_required' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, 'ghost-batches');
    const [b] = await tx.select().from(ghostBatches).where(eq(ghostBatches.id, input.id));
    if (!b) return { status: 'not_found' as const };
    if (b.status !== 'scheduled') return { status: 'not_scheduled' as const };
    await tx
      .update(ghostBatches)
      .set({ status: 'cancelled', retiredAt: now })
      .where(eq(ghostBatches.id, b.id));
    await tx.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: input.adminUserId,
      action: 'ghost.cancel',
      targetType: 'ghost_batch',
      targetId: String(b.id),
      reason,
      details: { batchId: b.batchKey, activeDate: b.activeDate },
      requestId: input.requestId ?? null,
      createdAt: now,
    });
    return { status: 'ok' as const };
  });
}
