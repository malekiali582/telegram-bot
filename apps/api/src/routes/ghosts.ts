import type { GhostBatchSummary, GhostTextIssue } from '@lulu/domain';
import {
  cancelGhostBatch,
  ghostBatchDetail,
  ghostOverview,
  importPanelGhostBatch,
} from '@lulu/domain';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import type {
  AddGhostBatchView,
  GhostBatchDetailView,
  GhostBatchView,
  GhostOverviewView,
} from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
// Generous bounds; the real limits (batch size, platform text length) are the domain's.
const addBody = z.object({
  activeDate: z.string().max(20),
  texts: z.array(z.string().max(20_000)).max(50),
});
const cancelBody = z.object({ reason: z.string().trim().min(1).max(500) });

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);
const PLATFORM = { telegram: 'تلگرام', rubika: 'روبیکا' } as const;

const batchView = (b: GhostBatchSummary): GhostBatchView => ({
  ...b,
  importedAt: b.importedAt.toISOString(),
  activatedAt: iso(b.activatedAt),
  retiredAt: iso(b.retiredAt),
});

function textMessage(issue: GhostTextIssue | null): string | null {
  if (!issue) return null;
  switch (issue.code) {
    case 'empty':
      return 'این متن خالی است.';
    case 'too_long':
      return `${fa(issue.length)} نویسه است؛ حداکثر ${fa(issue.limit)} نویسه (محدودیت پیام ${PLATFORM[issue.decidedBy]}).`;
    case 'duplicate':
      return `همان متن ${fa(issue.of + 1)} است.`;
  }
}

const CONFLICT = {
  date_taken:
    'برای این شب از قبل بسته‌ای در صف هست. اگر می‌خواهید عوضش کنید، اول آن بسته را لغو کنید.',
  date_in_past: 'تاریخ این بسته گذشته است.',
  different_content: 'بسته‌ای با همین شناسه و متن دیگری از قبل ثبت شده است.',
} as const;

export const ghostRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get('/api/ghosts', { config: { access: 'admin' } }, async (): Promise<GhostOverviewView> => {
    const o = await ghostOverview(ctx);
    return {
      ...o,
      active: o.active ? batchView(o.active) : null,
      upcoming: o.upcoming.map(batchView),
      past: o.past.map(batchView),
    };
  });

  app.get(
    '/api/ghosts/:id',
    { config: { access: 'admin' } },
    async (request): Promise<GhostBatchDetailView> => {
      const { id } = parseInput(idParam, request.params);
      const d = await ghostBatchDetail(ctx, id);
      if (!d) throw new ApiError('not_found', { message: 'این بسته پیدا نشد.' });
      return {
        batch: batchView(d.batch),
        stories: d.stories,
        cancellation: d.cancellation
          ? { ...d.cancellation, at: d.cancellation.at.toISOString() }
          : null,
      };
    },
  );

  app.post(
    '/api/ghosts',
    { config: { access: 'admin' } },
    async (request): Promise<AddGhostBatchView> => {
      const body = parseInput(addBody, request.body);
      const result = await importPanelGhostBatch(ctx, {
        ...body,
        adminUserId: request.session!.admin.id,
        requestId: request.id,
      });
      switch (result.status) {
        case 'imported':
        case 'already_imported':
          return result;
        case 'conflict':
          throw new ApiError('conflict', { message: CONFLICT[result.reason] });
        case 'invalid':
          return {
            status: 'invalid',
            activeDate:
              result.activeDate === 'in_past'
                ? 'تاریخ گذشته است؛ بسته فقط برای امروز یا روزهای بعد پذیرفته می‌شود.'
                : result.activeDate === 'invalid'
                  ? 'تاریخ درست نیست.'
                  : null,
            texts: result.texts.map(textMessage),
            form: result.wrongCount
              ? `بسته باید دقیقاً ${fa(result.wrongCount.expected)} متن داشته باشد.`
              : null,
          };
      }
    },
  );

  app.post('/api/ghosts/:id/cancel', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const { reason } = parseInput(cancelBody, request.body);
    const result = await cancelGhostBatch(ctx, {
      id,
      reason,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
    });
    switch (result.status) {
      case 'ok':
        return { ok: true };
      case 'not_found':
        throw new ApiError('not_found', { message: 'این بسته پیدا نشد.' });
      case 'not_scheduled':
        throw new ApiError('conflict', {
          message: 'فقط بستهٔ در صف لغو می‌شود؛ بستهٔ فعال یا گذشته دست‌نخورده می‌ماند.',
        });
      case 'reason_required':
        throw new ApiError('invalid_request', { message: 'نوشتن دلیل الزامی است.' });
    }
  });

  done();
};
