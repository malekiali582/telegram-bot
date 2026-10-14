import { CURSE_KINDS, FOOD_KINDS } from '@lulu/config';
import type { AdminGroupDetail, GroupListItem, GroupMigrationView } from '@lulu/domain';
import {
  adminGroupDetail,
  migrationOverview,
  reviewMigrationConflict,
  searchGroups,
  setGroupDisabled,
} from '@lulu/domain';
import { CURSE_NAMES, FOOD_NAMES, levelName } from '@lulu/i18n';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import type {
  GroupDetailView,
  GroupListItemView,
  GroupListView,
  GroupMigrationItemView,
  MigrationOverviewView,
} from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

const PAGE_SIZE = 25;
const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(['active', 'disabled', 'removed']).optional(),
  platform: z.enum(['telegram', 'rubika']).optional(),
  sort: z.enum(['recent', 'newest', 'members']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const disableBody = z.object({ disabled: z.boolean(), reason: z.string().trim().min(1).max(500) });
const reviewBody = z.object({ note: z.string().trim().min(1).max(1000) });

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

const listItem = ({ bloodBankCenti, ...g }: GroupListItem): GroupListItemView => ({
  ...g,
  disabledAt: iso(g.disabledAt),
  createdAt: g.createdAt.toISOString(),
  bloodBank: bloodBankCenti.toString(),
  lastActivityAt: iso(g.lastActivityAt),
});

const migration = (m: GroupMigrationView): GroupMigrationItemView => ({
  ...m,
  detectedAt: m.detectedAt.toISOString(),
  review: m.review ? { ...m.review, at: m.review.at.toISOString() } : null,
});

function detail(d: AdminGroupDetail): GroupDetailView {
  const c = d.city;
  return {
    group: {
      ...d.group,
      botAddedAt: d.group.botAddedAt.toISOString(),
      botRemovedAt: iso(d.group.botRemovedAt),
      createdAt: d.group.createdAt.toISOString(),
      disabledAt: iso(d.group.disabledAt),
    },
    identity: d.identity ? { ...d.identity, since: d.identity.since.toISOString() } : null,
    previousChatIds: d.previousChatIds.map((p) => ({
      ...p,
      replacedAt: p.replacedAt.toISOString(),
    })),
    city: {
      level: c.level,
      maxLevel: c.maxLevel,
      population: c.population,
      huntStore: {
        points: c.huntStore.points,
        donatedTotal: c.huntStore.donatedTotal,
        donatedByFood: FOOD_KINDS.map((kind) => ({
          kind,
          name: FOOD_NAMES[kind],
          count: c.huntStore.donatedByFood[kind],
        })).filter((f) => f.count > 0),
      },
      bloodBank: {
        balance: c.bloodBank.balanceCenti.toString(),
        level: c.bloodBank.level,
        donatedTotal: c.bloodBank.donatedTotalCenti.toString(),
      },
      huntingGround: c.huntingGround,
      curses: CURSE_KINDS.map((kind) => ({ kind, name: CURSE_NAMES[kind], ...c.curses[kind] })),
      next: {
        city: c.next.city && {
          level: c.next.city.level,
          bloodBankCost: c.next.city.bloodBankCostCenti.toString(),
          huntPointsCost: c.next.city.huntPointsCost,
        },
        bloodBank: c.next.bloodBank && {
          level: c.next.bloodBank.level,
          cost: c.next.bloodBank.costCenti.toString(),
        },
        huntingGround: c.next.huntingGround && {
          level: c.next.huntingGround.level,
          cost: c.next.huntingGround.costCenti.toString(),
        },
      },
    },
    members: {
      ...d.members,
      list: d.members.list.map((m) => ({
        ...m,
        joinedAt: m.joinedAt.toISOString(),
        lastSuccessAt: iso(m.lastSuccessAt),
      })),
    },
    leaderboard: d.leaderboard.map((e) => ({
      rank: e.rank,
      userId: e.userId,
      displayName: e.displayName,
      points: e.pointsCenti.toString(),
      levelName: levelName(e.level),
    })),
    migrations: d.migrations.map(migration),
  };
}

export const groupRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get(
    '/api/groups',
    { config: { access: 'admin' } },
    async (request): Promise<GroupListView> => {
      const q = parseInput(listQuery, request.query);
      const result = await searchGroups(ctx, {
        ...(q.q ? { query: q.q } : {}),
        ...(q.status ? { status: q.status } : {}),
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
    '/api/groups/migrations',
    { config: { access: 'admin' } },
    async (): Promise<MigrationOverviewView> => {
      const o = await migrationOverview(ctx);
      return {
        openConflicts: o.openConflicts.map(migration),
        recent: o.recent.map(migration),
        groupsWithPreviousIds: o.groupsWithPreviousIds.map((g) => ({
          ...g,
          previous: g.previous.map((p) => ({ ...p, replacedAt: p.replacedAt.toISOString() })),
        })),
      };
    },
  );

  app.post(
    '/api/groups/migrations/:id/review',
    { config: { access: 'admin' } },
    async (request) => {
      const { id } = parseInput(idParam, request.params);
      const { note } = parseInput(reviewBody, request.body);
      const result = await reviewMigrationConflict(ctx, {
        migrationId: id,
        note,
        adminUserId: request.session!.admin.id,
        requestId: request.id,
      });
      if (result.status === 'not_found') {
        throw new ApiError('not_found', { message: 'این تعارض پیدا نشد یا قبلاً بررسی شده است.' });
      }
      if (result.status === 'note_required') {
        throw new ApiError('invalid_request', { message: 'نوشتن توضیح الزامی است.' });
      }
      return { reviewed: true };
    },
  );

  app.get(
    '/api/groups/:id',
    { config: { access: 'admin' } },
    async (request): Promise<GroupDetailView> => {
      const { id } = parseInput(idParam, request.params);
      const found = await adminGroupDetail(ctx, id);
      if (!found) throw new ApiError('not_found', { message: 'این گروه پیدا نشد.' });
      return detail(found);
    },
  );

  app.post('/api/groups/:id/disable', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(disableBody, request.body);
    const result = await setGroupDisabled(ctx, {
      groupId: id,
      disabled: body.disabled,
      reason: body.reason,
      adminUserId: request.session!.admin.id,
      requestId: request.id,
    });
    if (result.status === 'not_found')
      throw new ApiError('not_found', { message: 'این گروه پیدا نشد.' });
    if (result.status === 'reason_required') {
      throw new ApiError('invalid_request', { message: 'نوشتن دلیل الزامی است.' });
    }
    if (result.status === 'unchanged') {
      throw new ApiError('conflict', {
        message: body.disabled ? 'این گروه از قبل غیرفعال است.' : 'این گروه غیرفعال نیست.',
      });
    }
    return { disabled: body.disabled };
  });

  done();
};
