import { createHash } from 'node:crypto';
import { GAME_TIME_ZONE } from '@lulu/config';
import { maxGhostStoryLength } from '@lulu/platform';
import { ghostBatches, ghostStories, inTransaction } from '@lulu/database';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainContext } from './context.ts';
import { lockKey } from './players.ts';
import { isValidDate, tehranDate } from './tehran.ts';

const batchSchema = z.strictObject({
  batchId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'batchId may contain only A-Z a-z 0-9 _ . : -'),
  activeDate: z.string().refine(isValidDate, 'activeDate must be a real YYYY-MM-DD date'),
  timezone: z.literal(GAME_TIME_ZONE),
  stories: z.array(
    z.strictObject({
      id: z.string().trim().min(1, 'story id is empty').max(64),
      text: z.string(),
    }),
  ),
});

export interface GhostBatch {
  batchId: string;
  activeDate: string;
  stories: { id: string; text: string }[];
}

export type GhostBatchValidation =
  { ok: true; batch: GhostBatch } | { ok: false; errors: string[] };

/**
 * A nightly batch is accepted only with exactly `batchSize` (5) stories, each with a
 * unique id and non-empty text no longer than every enabled platform can deliver. Anything else is rejected as a whole, so a partial
 * file can never replace the live batch.
 */
export interface GhostBatchLimits {
  batchSize: number;
  /** From the enabled platforms' message limits (see maxGhostStoryLength). */
  maxStoryLength: number;
  /** Named in the error so the owner knows which platform is the constraint. */
  lengthDecidedBy?: string;
}

export function validateGhostBatch(input: unknown, limits: GhostBatchLimits): GhostBatchValidation {
  const { batchSize, maxStoryLength } = limits;
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const errors: string[] = [];
  const stories = parsed.data.stories.map((s) => ({ id: s.id.trim(), text: s.text.trim() }));
  if (stories.length !== batchSize) {
    errors.push(`stories: expected exactly ${batchSize}, got ${stories.length}`);
  }
  const seen = new Set<string>();
  stories.forEach((s, i) => {
    if (seen.has(s.id)) errors.push(`stories.${i}.id: duplicate id «${s.id}»`);
    seen.add(s.id);
    if (s.text === '') errors.push(`stories.${i}.text: empty`);
    if (s.text.length > maxStoryLength) {
      const by = limits.lengthDecidedBy ? ` (${limits.lengthDecidedBy})` : '';
      errors.push(`stories.${i}.text: ${s.text.length} characters, limit ${maxStoryLength}${by}`);
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    batch: { batchId: parsed.data.batchId.trim(), activeDate: parsed.data.activeDate, stories },
  };
}

function contentHash(batch: GhostBatch): string {
  return createHash('sha256')
    .update(JSON.stringify({ activeDate: batch.activeDate, stories: batch.stories }))
    .digest('hex');
}

export type ImportGhostBatchResult =
  | { status: 'imported'; batchId: string; activeDate: string }
  /** The same batch (same id and content) was imported before; nothing changed. */
  | { status: 'already_imported'; batchId: string }
  | { status: 'invalid'; errors: string[] }
  | { status: 'conflict'; reason: 'different_content' | 'date_taken' | 'date_in_past' };

/**
 * Stores a validated batch as `scheduled`; it goes live at the start of its Tehran
 * `activeDate` (see `activateDueBatches`). Importing the same batch again is a no-op,
 * so the file importer and the panel form can both call this safely.
 */
export async function importGhostBatch(
  ctx: DomainContext,
  input: unknown,
  options: { source: 'file' | 'panel' | 'dev_seed'; isSample?: boolean; adminUserId?: number },
): Promise<ImportGhostBatchResult> {
  const now = ctx.clock.now();
  const { config } = await ctx.config.effectiveAt(ctx.db, now);
  const { limit, decidedBy } = maxGhostStoryLength(ctx.platforms);
  const validation = validateGhostBatch(input, {
    batchSize: config.ghosts.batchSize,
    maxStoryLength: limit,
    lengthDecidedBy: decidedBy,
  });
  if (!validation.ok) return { status: 'invalid', errors: validation.errors };
  const batch = validation.batch;
  const hash = contentHash(batch);

  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, 'ghost-batches');
    const [existing] = await tx
      .select()
      .from(ghostBatches)
      .where(eq(ghostBatches.batchKey, batch.batchId));
    if (existing) {
      return existing.contentHash === hash
        ? { status: 'already_imported' as const, batchId: batch.batchId }
        : { status: 'conflict' as const, reason: 'different_content' as const };
    }
    if (batch.activeDate < tehranDate(now)) {
      return { status: 'conflict' as const, reason: 'date_in_past' as const };
    }
    const [taken] = await tx
      .select({ id: ghostBatches.id })
      .from(ghostBatches)
      .where(
        and(eq(ghostBatches.activeDate, batch.activeDate), eq(ghostBatches.status, 'scheduled')),
      );
    if (taken) return { status: 'conflict' as const, reason: 'date_taken' as const };

    const [row] = await tx
      .insert(ghostBatches)
      .values({
        batchKey: batch.batchId,
        activeDate: batch.activeDate,
        timezone: GAME_TIME_ZONE,
        status: 'scheduled',
        isSample: options.isSample ?? false,
        source: options.source,
        contentHash: hash,
        importedAt: now,
        importedByAdminId: options.adminUserId ?? null,
      })
      .returning({ id: ghostBatches.id });
    if (!row) throw new Error('batch insert returned nothing');
    await tx.insert(ghostStories).values(
      batch.stories.map((s, i) => ({
        batchId: row.id,
        storyKey: s.id,
        position: i + 1,
        text: s.text,
      })),
    );
    return { status: 'imported' as const, batchId: batch.batchId, activeDate: batch.activeDate };
  });
}

/**
 * Makes the newest batch whose Tehran `activeDate` has started the live one, in a
 * single transaction: the previous live batch is retired (out of live selection, its
 * rows and every encounter snapshot kept), older never-shown batches are cancelled.
 * Idempotent; called by the worker and lazily before each ghost search.
 */
export async function activateDueBatches(
  ctx: DomainContext,
): Promise<{ activated: string | null; retired: string | null; cancelled: string[] }> {
  const now = ctx.clock.now();
  const today = tehranDate(now);
  return inTransaction(ctx.db, async (tx) => {
    await lockKey(tx, 'ghost-batches');
    const due = await tx
      .select()
      .from(ghostBatches)
      .where(and(eq(ghostBatches.status, 'scheduled'), lte(ghostBatches.activeDate, today)))
      .orderBy(desc(ghostBatches.activeDate));
    const [next, ...stale] = due;
    if (!next) return { activated: null, retired: null, cancelled: [] };

    const [current] = await tx.select().from(ghostBatches).where(eq(ghostBatches.status, 'active'));
    if (current) {
      await tx
        .update(ghostBatches)
        .set({ status: 'retired', retiredAt: now })
        .where(eq(ghostBatches.id, current.id));
    }
    if (stale.length > 0) {
      await tx
        .update(ghostBatches)
        .set({ status: 'cancelled', retiredAt: now })
        .where(
          inArray(
            ghostBatches.id,
            stale.map((s) => s.id),
          ),
        );
    }
    await tx
      .update(ghostBatches)
      .set({ status: 'active', activatedAt: now })
      .where(eq(ghostBatches.id, next.id));
    return {
      activated: next.batchKey,
      retired: current?.batchKey ?? null,
      cancelled: stale.map((s) => s.batchKey),
    };
  });
}

export interface GhostContentStatus {
  today: string;
  active: { batchId: string; activeDate: string; isSample: boolean } | null;
  nextScheduled: { batchId: string; activeDate: string } | null;
  /** For the admin panel: no content at all, or today's texts were not delivered. */
  warning: 'no_active_batch' | 'stale_batch' | null;
}

export async function ghostContentStatus(ctx: DomainContext): Promise<GhostContentStatus> {
  const today = tehranDate(ctx.clock.now());
  const [active] = await ctx.db
    .select()
    .from(ghostBatches)
    .where(eq(ghostBatches.status, 'active'));
  const [next] = await ctx.db
    .select()
    .from(ghostBatches)
    .where(eq(ghostBatches.status, 'scheduled'))
    .orderBy(ghostBatches.activeDate)
    .limit(1);
  return {
    today,
    active: active
      ? { batchId: active.batchKey, activeDate: active.activeDate, isSample: active.isSample }
      : null,
    nextScheduled: next ? { batchId: next.batchKey, activeDate: next.activeDate } : null,
    warning: !active ? 'no_active_batch' : active.activeDate < today ? 'stale_batch' : null,
  };
}
