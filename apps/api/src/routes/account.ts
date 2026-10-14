import { adminUsers } from '@lulu/database';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import {
  changeOwnPassword,
  listOwnSessions,
  revokeOtherSessions,
  revokeOwnSession,
} from '../auth/manage.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password.ts';
import { requirePassword } from '../auth/reauth.ts';
import type { AccountView } from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

/** «حساب من»: one's own password and sessions. For every admin. */

const passwordBody = z.object({
  currentPassword: z.string().max(PASSWORD_MAX_LENGTH * 4),
  newPassword: z.string().max(PASSWORD_MAX_LENGTH * 4),
});
const sessionParam = z.object({ id: z.string().max(64) });
const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);

export const accountRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get(
    '/api/account',
    { config: { access: 'admin' } },
    async (request): Promise<AccountView> => {
      const session = request.session!;
      const now = ctx.clock.now();
      const [me] = await ctx.db
        .select({ createdAt: adminUsers.createdAt })
        .from(adminUsers)
        .where(eq(adminUsers.id, session.admin.id));
      const sessions = await listOwnSessions(ctx.db, {
        adminUserId: session.admin.id,
        currentTokenHash: session.tokenHash,
        now,
        idleMs: session.idleMs,
      });
      return {
        user: session.admin,
        createdAt: me!.createdAt.toISOString(),
        passwordMinLength: PASSWORD_MIN_LENGTH,
        sessions: sessions.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.post('/api/account/password', { config: { access: 'admin' } }, async (request) => {
    const body = parseInput(passwordBody, request.body);
    await requirePassword(deps, request, body.currentPassword);
    const session = request.session!;
    const result = await changeOwnPassword(ctx.db, {
      adminUserId: session.admin.id,
      password: body.newPassword,
      keepTokenHash: session.tokenHash,
      requestId: request.id,
      now: ctx.clock.now(),
    });
    if (result.status === 'weak_password') {
      throw new ApiError('invalid_request', {
        message:
          result.problem === 'too_short'
            ? `رمز تازه باید دست‌کم ${fa(PASSWORD_MIN_LENGTH)} نویسه باشد.`
            : `رمز تازه نباید بیشتر از ${fa(PASSWORD_MAX_LENGTH)} نویسه باشد.`,
      });
    }
    return { ok: true };
  });

  app.post('/api/account/sessions/:id/revoke', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(sessionParam, request.params);
    const session = request.session!;
    const result = await revokeOwnSession(ctx.db, {
      adminUserId: session.admin.id,
      sessionId: id,
      currentTokenHash: session.tokenHash,
      requestId: request.id,
      now: ctx.clock.now(),
    });
    if (result.status === 'not_found') {
      throw new ApiError('not_found', { message: 'این نشست پیدا نشد یا تمام شده است.' });
    }
    if (result.status === 'current') {
      throw new ApiError('invalid_request', {
        message: 'برای بستن همین نشست از «خروج» استفاده کنید.',
      });
    }
    return { ok: true };
  });

  app.post(
    '/api/account/sessions/revoke-others',
    { config: { access: 'admin' } },
    async (request) => {
      const session = request.session!;
      return revokeOtherSessions(ctx.db, {
        adminUserId: session.admin.id,
        currentTokenHash: session.tokenHash,
        requestId: request.id,
        now: ctx.clock.now(),
      });
    },
  );

  done();
};
