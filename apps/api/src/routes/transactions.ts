import { Readable } from 'node:stream';
import { auditLogs } from '@lulu/database';
import type { TransactionCursor, TransactionFilter, TransactionItem } from '@lulu/domain';
import {
  allTransactions,
  isValidDate,
  listTransactions,
  summarizeTransactions,
} from '@lulu/domain';
import { TRANSACTION_KIND_NAMES, transactionKindName } from '@lulu/i18n';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import type { NamedKind, TransactionListView, TransactionView } from '../contract.ts';
import { CSV_BOM, csvLine, jalaliDateTime, parsePoints, pointsText, safeText } from '../csv.ts';
import { ApiError, parseInput } from '../errors.ts';

const PAGE_SIZE = 50;
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Gregorian Tehran day; a sane year range also catches a Jalali date sent by mistake. */
const day = z
  .string()
  .refine((d) => isValidDate(d) && d >= '2020-01-01' && d <= '2100-12-31', 'YYYY-MM-DD');
const points = z
  .string()
  .max(40)
  .transform((v, c) => {
    const centi = parsePoints(v);
    if (centi === null) {
      c.addIssue({ code: 'custom', message: 'points' });
      return z.NEVER;
    }
    return centi;
  });

const filterQuery = z.object({
  userId: id.optional(),
  groupId: id.optional(),
  /** Comma-separated kinds. */
  kind: z
    .string()
    .regex(/^[a-z_]+(,[a-z_]+)*$/)
    .max(500)
    .optional(),
  from: day.optional(),
  to: day.optional(),
  min: points.optional(),
  max: points.optional(),
  cursor: z.string().max(100).optional(),
});

export function encodeCursor(c: TransactionCursor): string {
  return Buffer.from(`${c.effectiveAt.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(text: string): TransactionCursor {
  const [at, raw] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  const effectiveAt = new Date(at ?? '');
  const n = Number(raw);
  if (Number.isNaN(effectiveAt.getTime()) || !Number.isSafeInteger(n) || n < 1) {
    throw new ApiError('invalid_request');
  }
  return { effectiveAt, id: n };
}

function toFilter(q: z.output<typeof filterQuery>): TransactionFilter {
  return {
    ...(q.userId !== undefined ? { userId: q.userId } : {}),
    ...(q.groupId !== undefined ? { groupId: q.groupId } : {}),
    ...(q.kind ? { kinds: q.kind.split(',') } : {}),
    ...(q.from ? { fromDay: q.from } : {}),
    ...(q.to ? { toDay: q.to } : {}),
    ...(q.min !== undefined ? { minCenti: q.min } : {}),
    ...(q.max !== undefined ? { maxCenti: q.max } : {}),
  };
}

const ACCOUNT = {
  user_cash: 'cash',
  user_treasury: 'treasury',
  group_blood_bank: 'blood_bank',
  system: 'system',
} as const;

function view(t: TransactionItem): TransactionView {
  return {
    id: t.id,
    kind: t.kind,
    kindName: transactionKindName(t.kind),
    effectiveAt: t.effectiveAt.toISOString(),
    recordedAt: t.recordedAt.toISOString(),
    user: t.user,
    group: t.group,
    admin: t.admin,
    reason: t.reason,
    amount: t.amountCenti.toString(),
    playerDelta: t.playerDeltaCenti?.toString() ?? null,
    entries: t.entries.map((e) => ({
      account: ACCOUNT[e.walletKind],
      userId: e.userId,
      groupId: e.groupId,
      systemCode: e.systemCode,
      amount: e.amountCenti.toString(),
    })),
  };
}

const CSV_HEADER = [
  'شناسه',
  'نوع',
  'کد نوع',
  'تاریخ (شمسی، تهران)',
  'زمان (ISO، UTC)',
  'شناسهٔ بازیکن',
  'نام بازیکن',
  'شناسهٔ گروه',
  'نام گروه',
  'مبلغ (پوینت)',
  'تغییر موجودی بازیکن (پوینت)',
  'مدیر',
  'دلیل',
];

export const transactionRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  const { ctx } = deps;

  app.get('/api/transactions/kinds', { config: { access: 'admin' } }, (_request, reply) => {
    const kinds: NamedKind[] = Object.entries(TRANSACTION_KIND_NAMES)
      .map(([kind, name]) => ({ kind, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    return reply.send(kinds);
  });

  app.get(
    '/api/transactions',
    { config: { access: 'admin' } },
    async (request): Promise<TransactionListView> => {
      const q = parseInput(filterQuery, request.query);
      const filter = toFilter(q);
      const after = q.cursor ? decodeCursor(q.cursor) : undefined;
      const page = await listTransactions(ctx, filter, {
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      });
      const summary = after ? null : await summarizeTransactions(ctx, filter);
      return {
        items: page.items.map(view),
        next: page.next ? encodeCursor(page.next) : null,
        summary: summary ? { count: summary.count, amount: summary.amountCenti.toString() } : null,
      };
    },
  );

  app.get(
    '/api/transactions/export.csv',
    { config: { access: 'admin' } },
    async (request, reply) => {
      const q = parseInput(filterQuery, request.query);
      const filter = toFilter(q);
      const now = ctx.clock.now();
      await ctx.db.insert(auditLogs).values({
        actor: 'admin',
        adminUserId: request.session!.admin.id,
        action: 'transactions.export',
        targetType: 'transactions',
        details: {
          ...filter,
          minCenti: filter.minCenti?.toString(),
          maxCenti: filter.maxCenti?.toString(),
        },
        requestId: request.id,
        createdAt: now,
      });

      const withDelta = filter.userId !== undefined;
      async function* lines() {
        yield CSV_BOM + csvLine(CSV_HEADER);
        for await (const t of allTransactions(ctx, filter)) {
          yield csvLine([
            t.id,
            transactionKindName(t.kind),
            t.kind,
            jalaliDateTime(t.effectiveAt),
            t.effectiveAt.toISOString(),
            t.user?.id,
            safeText(t.user?.displayName),
            t.group?.id,
            safeText(t.group?.title),
            pointsText(t.amountCenti),
            withDelta && t.playerDeltaCenti !== null ? pointsText(t.playerDeltaCenti) : '',
            safeText(t.admin?.username),
            safeText(t.reason),
          ]);
        }
      }
      const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="lulu-transactions-${stamp}Z.csv"`)
        .send(Readable.from(lines()));
    },
  );

  done();
};
