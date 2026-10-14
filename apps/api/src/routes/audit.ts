import { isValidDate } from '@lulu/domain';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import { auditFilterOptions, searchAudit } from '../audit.ts';
import type { AuditFiltersView, AuditListView } from '../contract.ts';
import { parseInput } from '../errors.ts';

const PAGE_SIZE = 50;
/** Gregorian Tehran day; a sane year range also catches a Jalali date sent by mistake. */
const day = z
  .string()
  .refine((d) => isValidDate(d) && d >= '2020-01-01' && d <= '2100-12-31', 'YYYY-MM-DD');
const listQuery = z.object({
  admin: z
    .union([z.literal('system'), z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
    .optional(),
  action: z.string().max(64).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

export const auditRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get(
    '/api/audit',
    { config: { access: 'admin' } },
    async (request): Promise<AuditListView> => {
      const q = parseInput(listQuery, request.query);
      const { items, total } = await searchAudit(
        ctx.db,
        {
          ...(q.admin !== undefined ? { actor: q.admin } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.targetType ? { targetType: q.targetType } : {}),
          ...(q.targetId ? { targetId: q.targetId } : {}),
          ...(q.from ? { fromDay: q.from } : {}),
          ...(q.to ? { toDay: q.to } : {}),
          ...(q.q ? { query: q.q } : {}),
        },
        { limit: PAGE_SIZE, offset: (q.page - 1) * PAGE_SIZE },
      );
      return {
        items: items.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        total,
        page: q.page,
        pageSize: PAGE_SIZE,
      };
    },
  );

  app.get('/api/audit/filters', { config: { access: 'admin' } }, (): Promise<AuditFiltersView> =>
    auditFilterOptions(ctx.db),
  );

  done();
};
