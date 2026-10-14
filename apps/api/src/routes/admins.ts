import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import type { CreateAdminResult } from '../auth/admins.ts';
import type { AdminChangeResult, PasswordChangeResult } from '../auth/manage.ts';
import {
  addAdmin,
  listAdmins,
  setAdminDisabled,
  setAdminPassword,
  setAdminRole,
} from '../auth/manage.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password.ts';
import { requirePassword } from '../auth/reauth.ts';
import type { AdminListItemView } from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

/** Panel accounts: owner only, and every change asks for the owner's password again. */

const password = z
  .string()
  .max(PASSWORD_MAX_LENGTH * 4)
  .optional();
const newPassword = z.string().max(PASSWORD_MAX_LENGTH * 4);
const role = z.enum(['owner', 'admin']);
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const createBody = z.object({ username: z.string().max(64), newPassword, role, password });
const roleBody = z.object({ role, password });
const disableBody = z.object({ disabled: z.boolean(), reason: z.string().max(500), password });
const passwordBody = z.object({ newPassword, password });

const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);
const weak = (problem: 'too_short' | 'too_long') =>
  new ApiError('invalid_request', {
    message:
      problem === 'too_short'
        ? `رمز باید دست‌کم ${fa(PASSWORD_MIN_LENGTH)} نویسه باشد.`
        : `رمز نباید بیشتر از ${fa(PASSWORD_MAX_LENGTH)} نویسه باشد.`,
  });

function finish(result: AdminChangeResult | PasswordChangeResult, selfMessage: string) {
  switch (result.status) {
    case 'ok':
      return { ok: true };
    case 'not_found':
      throw new ApiError('not_found', { message: 'این مدیر پیدا نشد.' });
    case 'unchanged':
      throw new ApiError('invalid_request', { message: 'چیزی تغییر نکرد.' });
    case 'last_owner':
      throw new ApiError('conflict', {
        message: 'این آخرین مالک فعال است؛ پنل بدون مالک نمی‌ماند. اول مالک دیگری بسازید.',
      });
    case 'self':
      throw new ApiError('invalid_request', { message: selfMessage });
    case 'weak_password':
      throw weak(result.problem);
  }
}

function created(result: CreateAdminResult) {
  switch (result.status) {
    case 'ok':
      return { id: result.adminUserId };
    case 'invalid_username':
      throw new ApiError('invalid_request', {
        message: 'نام کاربری باید ۳ تا ۳۲ نویسه باشد: حروف کوچک انگلیسی، رقم، و نشانه‌های _ . -',
      });
    case 'weak_password':
      throw weak(result.problem);
    case 'username_taken':
      throw new ApiError('conflict', { message: 'این نام کاربری از قبل هست.' });
  }
}

export const adminRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;
  const actor = (request: { session?: { admin: { id: number } } | null; id: string }) => ({
    actorId: request.session!.admin.id,
    requestId: request.id,
    now: ctx.clock.now(),
  });

  app.get(
    '/api/admins',
    { config: { access: 'owner' } },
    async (request): Promise<AdminListItemView[]> => {
      const now = ctx.clock.now();
      const { config } = await ctx.config.effectiveAt(ctx.db, now);
      const admins = await listAdmins(ctx.db, now, config.admin.sessionIdleMinutes * 60_000);
      return admins.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        disabledAt: a.disabledAt?.toISOString() ?? null,
        lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
        you: a.id === request.session!.admin.id,
      }));
    },
  );

  app.post('/api/admins', { config: { access: 'owner' } }, async (request) => {
    const body = parseInput(createBody, request.body);
    await requirePassword(deps, request, body.password);
    return created(
      await addAdmin(ctx.db, {
        ...actor(request),
        username: body.username,
        password: body.newPassword,
        role: body.role,
      }),
    );
  });

  app.post('/api/admins/:id/role', { config: { access: 'owner' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(roleBody, request.body);
    await requirePassword(deps, request, body.password);
    return finish(
      await setAdminRole(ctx.db, { ...actor(request), targetId: id, role: body.role }),
      '',
    );
  });

  app.post('/api/admins/:id/disable', { config: { access: 'owner' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(disableBody, request.body);
    await requirePassword(deps, request, body.password);
    return finish(
      await setAdminDisabled(ctx.db, {
        ...actor(request),
        targetId: id,
        disabled: body.disabled,
        reason: body.reason,
      }),
      'حساب خودتان را نمی‌توانید حذف کنید.',
    );
  });

  app.post('/api/admins/:id/password', { config: { access: 'owner' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(passwordBody, request.body);
    await requirePassword(deps, request, body.password);
    return finish(
      await setAdminPassword(ctx.db, {
        ...actor(request),
        targetId: id,
        password: body.newPassword,
      }),
      'رمز خودتان را از «حساب من» عوض کنید.',
    );
  });

  done();
};
