import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AnnouncementSummary } from '../announcements.ts';
import {
  announcementDetail,
  announcementRecipients,
  cancelAnnouncement,
  listAnnouncements,
  retryAnnouncementFailures,
  sendAnnouncement,
} from '../announcements.ts';
import type { ApiDeps } from '../app.ts';
import type {
  AnnouncementDetailView,
  AnnouncementListView,
  AnnouncementRecipientsView,
  AnnouncementView,
  PlatformName,
} from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

const PAGE_SIZE = 20;
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all_groups') }),
  z.object({ kind: z.literal('group'), groupId: positiveId }),
]);
const sendBody = z.object({ target, text: z.string().max(20_000), silent: z.boolean() });
const recipientsQuery = z.object({
  groupId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const listQuery = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1) });
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const NOT_FOUND = 'این اطلاعیه پیدا نشد.';
const GROUP_NOT_FOUND = 'این گروه پیدا نشد.';

const view = (a: AnnouncementSummary): AnnouncementView => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
  cancelledAt: iso(a.cancelledAt),
  lastSentAt: iso(a.lastSentAt),
});

export const announcementRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  const { ctx } = deps;
  const now = () => ctx.clock.now();

  app.get(
    '/api/announcements/recipients',
    { config: { access: 'admin' } },
    async (request): Promise<AnnouncementRecipientsView> => {
      const q = parseInput(recipientsQuery, request.query);
      const found = await announcementRecipients(
        ctx.db,
        ctx.platforms,
        q.groupId !== undefined ? { kind: 'group', groupId: q.groupId } : { kind: 'all_groups' },
      );
      if ('status' in found) throw new ApiError('not_found', { message: GROUP_NOT_FOUND });
      const byPlatform = new Map<PlatformName, number>();
      for (const r of found.recipients) {
        byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1);
      }
      return {
        count: found.recipients.length,
        byPlatform: [...byPlatform].map(([platform, count]) => ({ platform, count })),
        sample: found.recipients.slice(0, 5).map((r) => r.title),
        skipped: found.skipped,
        maxLength: found.maxLength,
      };
    },
  );

  app.post('/api/announcements', { config: { access: 'admin' } }, async (request) => {
    const body = parseInput(sendBody, request.body);
    const result = await sendAnnouncement(ctx.db, {
      platforms: ctx.platforms,
      target: body.target,
      text: body.text,
      silent: body.silent,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
      now: now(),
    });
    switch (result.status) {
      case 'ok':
        return { id: result.id, recipients: result.recipients };
      case 'empty_text':
        throw new ApiError('invalid_request', { message: 'متن اطلاعیه خالی است.' });
      case 'too_long':
        throw new ApiError('invalid_request', {
          message: `متن ${fa(result.length)} نویسه است؛ حداکثر ${fa(result.limit)} نویسه.`,
        });
      case 'no_recipients':
        throw new ApiError('invalid_request', {
          message: 'هیچ گروهی برای دریافت نیست (ربات در گروه نیست یا گروه غیرفعال است).',
        });
      case 'group_not_found':
        throw new ApiError('not_found', { message: GROUP_NOT_FOUND });
    }
  });

  app.get(
    '/api/announcements',
    { config: { access: 'admin' } },
    async (request): Promise<AnnouncementListView> => {
      const { page } = parseInput(listQuery, request.query);
      const { items, total } = await listAnnouncements(ctx.db, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      return { items: items.map(view), total, page, pageSize: PAGE_SIZE };
    },
  );

  app.get(
    '/api/announcements/:id',
    { config: { access: 'admin' } },
    async (request): Promise<AnnouncementDetailView> => {
      const { id } = parseInput(idParam, request.params);
      const d = await announcementDetail(ctx.db, id);
      if (!d) throw new ApiError('not_found', { message: NOT_FOUND });
      return {
        ...view(d),
        deliveries: d.deliveries.map((x) => ({
          ...x,
          sentAt: iso(x.sentAt),
          nextAttemptAt: x.nextAttemptAt.toISOString(),
        })),
      };
    },
  );

  app.post('/api/announcements/:id/cancel', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const result = await cancelAnnouncement(ctx.db, {
      id,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
      now: now(),
    });
    if (result.status === 'not_found') throw new ApiError('not_found', { message: NOT_FOUND });
    if (result.status === 'nothing_pending') {
      throw new ApiError('conflict', { message: 'پیام در صفی برای لغو نمانده است.' });
    }
    return { cancelled: result.cancelled };
  });

  app.post('/api/announcements/:id/retry', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const result = await retryAnnouncementFailures(ctx.db, {
      id,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
      now: now(),
    });
    if (result.status === 'not_found') throw new ApiError('not_found', { message: NOT_FOUND });
    if (result.status === 'nothing_failed') {
      throw new ApiError('conflict', { message: 'پیام ناموفقی برای ارسال دوباره نیست.' });
    }
    return { retried: result.retried };
  });

  done();
};
