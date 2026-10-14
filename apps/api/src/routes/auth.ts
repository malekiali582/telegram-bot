import { auditLogs } from '@lulu/database';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import { login, loginPolicy } from '../auth/login.ts';
import { PASSWORD_MAX_LENGTH } from '../auth/password.ts';
import { csrfTokenFor, revokeSession, sha256 } from '../auth/sessions.ts';
import type { AdminUserView, SessionView } from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';
import { waitText } from '../wait-text.ts';

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4),
});

export const authRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  const sessionView = (
    user: AdminUserView,
    token: string,
    expiresAt: Date,
    idleMs: number,
  ): SessionView => ({
    user,
    csrfToken: csrfTokenFor(deps.sessionSecret, token),
    idleTimeoutSeconds: idleMs / 1000,
    expiresAt: expiresAt.toISOString(),
    app: deps.app,
  });

  const clearCookie = (reply: FastifyReply) =>
    reply.clearCookie(deps.cookieName, {
      path: '/',
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'strict',
    });

  app.post('/api/auth/login', { config: { access: 'public' } }, async (request, reply) => {
    const body = parseInput(loginBody, request.body);
    const now = ctx.clock.now();
    const { config } = await ctx.config.effectiveAt(ctx.db, now);
    const policy = loginPolicy(config);

    // Logging in again replaces the session this browser had.
    const previous = request.cookies[deps.cookieName];
    if (previous) await revokeSession(ctx.db, sha256(previous), now);

    const result = await login(ctx.db, {
      username: body.username,
      password: body.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      now,
      secret: deps.sessionSecret,
      requestId: request.id,
      policy,
    });
    if (result.status === 'locked') {
      throw new ApiError('too_many_attempts', {
        message: `تلاش‌های ناموفق زیاد بود. ${waitText(result.retryAfterMs)} دیگر دوباره امتحان کنید.`,
        retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
      });
    }
    if (result.status === 'invalid_credentials') throw new ApiError('invalid_credentials');

    reply.setCookie(deps.cookieName, result.session.token, {
      path: '/',
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'strict',
      maxAge: Math.floor(policy.sessionTtlMs / 1000),
    });
    return sessionView(
      result.admin,
      result.session.token,
      result.session.expiresAt,
      config.admin.sessionIdleMinutes * 60_000,
    );
  });

  app.get('/api/auth/session', { config: { access: 'admin' } }, (request, reply) => {
    const session = request.session!;
    return reply.send(
      sessionView(
        session.admin,
        request.cookies[deps.cookieName]!,
        session.expiresAt,
        session.idleMs,
      ),
    );
  });

  app.post('/api/auth/logout', { config: { access: 'admin' } }, async (request, reply) => {
    const session = request.session!;
    const now = ctx.clock.now();
    await ctx.db.transaction(async (tx) => {
      await revokeSession(tx, session.tokenHash, now);
      await tx.insert(auditLogs).values({
        actor: 'admin',
        adminUserId: session.admin.id,
        action: 'auth.logout',
        targetType: 'admin_user',
        targetId: String(session.admin.id),
        requestId: request.id,
        createdAt: now,
      });
    });
    clearCookie(reply);
    return reply.code(204).send();
  });
  done();
};
