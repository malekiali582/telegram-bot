import type { AdminPlayerDetail, PlayerListItem } from '@lulu/domain';
import { adjustBalance, adminPlayerDetail, searchPlayers, setPlayerBan } from '@lulu/domain';
import { FOOD_NAMES, TOOL_NAMES, levelName } from '@lulu/i18n';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import type {
  AdjustBalanceResult,
  PlayerDetailView,
  PlayerListItemView,
  PlayerListView,
} from '../contract.ts';
import { parsePoints, pointsText } from '../csv.ts';
import { ApiError, parseInput } from '../errors.ts';

const PAGE_SIZE = 25;

const listQuery = z.object({
  q: z.string().max(100).optional(),
  banned: z.enum(['only', 'exclude']).optional(),
  platform: z.enum(['telegram', 'rubika']).optional(),
  sort: z.enum(['recent', 'newest', 'richest']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const reason = z.string().trim().min(1).max(500);
const adjustBody = z.object({
  wallet: z.enum(['cash', 'treasury']),
  amount: z.string().max(40),
  reason,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
const banBody = z.object({ banned: z.boolean(), reason });

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function listItem(p: PlayerListItem): PlayerListItemView {
  return {
    id: p.id,
    displayName: p.displayName,
    username: p.username,
    isSample: p.isSample,
    bannedAt: iso(p.bannedAt),
    createdAt: p.createdAt.toISOString(),
    level: p.level,
    levelName: levelName(p.level),
    cash: p.cashCenti.toString(),
    treasury: p.treasuryCenti.toString(),
    identities: p.identities,
    lastActiveAt: iso(p.lastActiveAt),
  };
}

function detail(d: AdminPlayerDetail): PlayerDetailView {
  const p = d.profile;
  const tool = (kind: keyof typeof TOOL_NAMES) => ({ kind, name: TOOL_NAMES[kind] });
  return {
    user: {
      ...d.user,
      createdAt: d.user.createdAt.toISOString(),
      bannedAt: iso(d.user.bannedAt),
    },
    identities: d.identities.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
    level: p.level,
    levelName: levelName(p.level),
    maxLevel: p.maxLevel,
    nextLevelCost: p.nextLevelCostCenti?.toString() ?? null,
    cash: p.cashCenti.toString(),
    treasury: p.treasuryCenti.toString(),
    tools: {
      owned: p.tools.owned.map(tool),
      equipped: p.tools.equipped ? tool(p.tools.equipped) : null,
    },
    inventory: Object.entries(p.inventory)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({ kind, name: FOOD_NAMES[kind as keyof typeof FOOD_NAMES], count })),
    meals: {
      active: p.meals.active.map((m) => ({
        kind: m.food,
        name: FOOD_NAMES[m.food],
        expiresAt: m.expiresAt.toISOString(),
        deposit: m.depositCenti.toString(),
        depositsLeft: m.depositsLeft,
      })),
      capacity: p.meals.capacity,
    },
    cemetery: p.cemetery
      ? { level: p.cemetery.level, hourlyIncome: p.cemetery.hourlyIncomeCenti.toString() }
      : null,
    waits: Object.entries(p.waits).map(([kind, until]) => ({ kind, until: until.toISOString() })),
    ghostsToday: p.ghostsToday,
    groups: d.groups.map((g) => ({
      ...g,
      joinedAt: g.joinedAt.toISOString(),
      lastSuccessAt: iso(g.lastSuccessAt),
    })),
    ghosts: {
      foundTotal: d.ghosts.foundTotal,
      heardTotal: d.ghosts.heardTotal,
      recent: d.ghosts.recent.map((e) => ({
        ...e,
        foundAt: e.foundAt.toISOString(),
        heardAt: iso(e.heardAt),
        expiresAt: e.expiresAt.toISOString(),
      })),
    },
    streakRewards: d.streakRewards.map((r) => ({
      date: r.date,
      groupId: r.groupId,
      groupTitle: r.groupTitle,
      streak: r.streak,
      activeMembers: r.activeMembers,
      personal: r.personalCenti.toString(),
      group: r.groupCenti.toString(),
    })),
  };
}

export const playerRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get(
    '/api/players',
    { config: { access: 'admin' } },
    async (request): Promise<PlayerListView> => {
      const q = parseInput(listQuery, request.query);
      const result = await searchPlayers(ctx, {
        ...(q.q ? { query: q.q } : {}),
        ...(q.banned ? { banned: q.banned } : {}),
        ...(q.platform ? { platform: q.platform } : {}),
        ...(q.sort ? { sort: q.sort } : {}),
        limit: PAGE_SIZE,
        offset: (q.page - 1) * PAGE_SIZE,
      });
      return {
        items: result.items.map(listItem),
        total: result.total,
        page: q.page,
        pageSize: PAGE_SIZE,
      };
    },
  );

  app.get(
    '/api/players/:id',
    { config: { access: 'admin' } },
    async (request): Promise<PlayerDetailView> => {
      const { id } = parseInput(idParam, request.params);
      const found = await adminPlayerDetail(ctx, id);
      if (!found) throw new ApiError('not_found', { message: 'این بازیکن پیدا نشد.' });
      return detail(found);
    },
  );

  app.post(
    '/api/players/:id/adjust',
    { config: { access: 'admin' } },
    async (request): Promise<AdjustBalanceResult> => {
      const { id } = parseInput(idParam, request.params);
      const body = parseInput(adjustBody, request.body);
      const amountCenti = parsePoints(body.amount);
      if (amountCenti === null || amountCenti === 0n) {
        throw new ApiError('invalid_request', {
          message: 'مبلغ باید عددی غیرصفر با حداکثر دو رقم اعشار باشد، مثلاً ۲۵۰ یا -۱۲٫۵.',
        });
      }
      const result = await adjustBalance(ctx, {
        userId: id,
        wallet: body.wallet,
        amountCenti,
        reason: body.reason,
        adminUserId: request.session!.admin.id,
        // Scoped to the player, so a key can never collide with a game transaction.
        idempotencyKey: `admin:${id}:${body.idempotencyKey}`,
        requestId: request.id,
      });
      switch (result.status) {
        case 'ok':
          return {
            transactionId: result.transactionId,
            balance: result.balanceCenti.toString(),
            duplicate: false,
          };
        case 'duplicate':
          return { transactionId: null, balance: null, duplicate: true };
        case 'insufficient_funds':
          throw new ApiError('conflict', {
            message: `موجودی کافی نیست؛ موجودی فعلی ${pointsText(result.balanceCenti)} پوینت است و موجودی منفی نمی‌شود.`,
          });
        case 'reason_required':
          throw new ApiError('invalid_request', { message: 'نوشتن دلیل الزامی است.' });
        case 'invalid_amount':
          throw new ApiError('invalid_request', { message: 'مبلغ نمی‌تواند صفر باشد.' });
      }
    },
  );

  app.post('/api/players/:id/ban', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(banBody, request.body);
    const result = await setPlayerBan(ctx, {
      userId: id,
      banned: body.banned,
      reason: body.reason,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
    });
    if (result.status === 'not_found')
      throw new ApiError('not_found', { message: 'این بازیکن پیدا نشد.' });
    if (result.status === 'reason_required') {
      throw new ApiError('invalid_request', { message: 'نوشتن دلیل الزامی است.' });
    }
    if (result.status === 'unchanged') {
      throw new ApiError('conflict', {
        message: body.banned ? 'این بازیکن از قبل مسدود است.' : 'این بازیکن مسدود نیست.',
      });
    }
    return { banned: body.banned };
  });

  done();
};
