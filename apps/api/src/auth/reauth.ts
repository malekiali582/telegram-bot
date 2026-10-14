import type { FastifyRequest } from 'fastify';
import type { ApiDeps } from '../app.ts';
import { ApiError } from '../errors.ts';
import { waitText } from '../wait-text.ts';
import { confirmPassword, loginPolicy } from './login.ts';

/**
 * «Enter your password again» for a sensitive action (backups, owner rules, managing
 * admins). Limited and recorded like a login. Throws the right Persian error.
 */
export async function requirePassword(
  deps: ApiDeps,
  request: FastifyRequest,
  password: string | undefined,
): Promise<void> {
  if (!password) {
    throw new ApiError('wrong_password', {
      message: 'برای این کار رمز خودتان را دوباره وارد کنید.',
    });
  }
  const { ctx } = deps;
  const now = ctx.clock.now();
  const { config } = await ctx.config.effectiveAt(ctx.db, now);
  const result = await confirmPassword(ctx.db, {
    username: request.session!.admin.username,
    password,
    ip: request.ip,
    now,
    policy: loginPolicy(config),
  });
  if (result.status === 'locked') {
    throw new ApiError('too_many_attempts', {
      message: `تلاش‌های ناموفق زیاد بود. ${waitText(result.retryAfterMs)} دیگر دوباره امتحان کنید.`,
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
    });
  }
  if (result.status === 'wrong_password') throw new ApiError('wrong_password');
}
