import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditLogs } from '@lulu/database';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import { confirmPassword, loginPolicy } from '../auth/login.ts';
import { PASSWORD_MAX_LENGTH } from '../auth/password.ts';
import { BackupError, createBackup, isBackupFileName, listBackups } from '../backup.ts';
import type { BackupCreatedView, BackupView, SystemView } from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';
import { systemStatus, retryDeadMessage } from '../system.ts';
import { waitText } from './auth.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const nameParam = z.object({ name: z.string().refine(isBackupFileName) });
const passwordBody = z.object({
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4),
});

export const systemRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  const audit = (
    request: FastifyRequest,
    action: string,
    target: { type: string; id: string },
    details: Record<string, unknown> = {},
  ) =>
    ctx.db.insert(auditLogs).values({
      actor: 'admin',
      adminUserId: request.session!.admin.id,
      action,
      targetType: target.type,
      targetId: target.id,
      details,
      requestId: request.id,
      createdAt: ctx.clock.now(),
    });

  /** The owner retypes their password; limited and recorded like a login. */
  const requirePassword = async (request: FastifyRequest) => {
    const { password } = parseInput(passwordBody, request.body);
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
  };

  const backupDir = () => {
    if (!deps.backups) {
      throw new ApiError('not_found', { message: 'بکاپ‌گیری روی این سرور تنظیم نشده است.' });
    }
    return deps.backups;
  };

  app.get('/api/system', { config: { access: 'admin' } }, async (): Promise<SystemView> =>
    systemStatus(ctx.db, ctx.clock.now()),
  );

  app.post('/api/system/outbox/:id/retry', { config: { access: 'admin' } }, async (request) => {
    const { id } = parseInput(idParam, request.params);
    const now = ctx.clock.now();
    const result = await ctx.db.transaction(async (tx) => {
      const r = await retryDeadMessage(tx, id, now);
      if (r.status === 'ok') {
        await tx.insert(auditLogs).values({
          actor: 'admin',
          adminUserId: request.session!.admin.id,
          action: 'outbox.retry',
          targetType: 'outbox',
          targetId: String(id),
          details: { previousError: r.previousError },
          requestId: request.id,
          createdAt: now,
        });
      }
      return r;
    });
    if (result.status === 'not_found') throw new ApiError('not_found');
    if (result.status === 'not_dead') {
      throw new ApiError('conflict', { message: 'این پیام دیگر در وضعیت «ناموفق» نیست.' });
    }
    return { status: 'pending' as const };
  });

  app.get('/api/system/backups', { config: { access: 'owner' } }, (_request, reply) => {
    const { dir, keep } = backupDir();
    const backups: BackupView[] = listBackups(dir);
    return reply.send({ backups, keep });
  });

  app.post(
    '/api/system/backups',
    { config: { access: 'owner' } },
    async (request): Promise<BackupCreatedView> => {
      const { dir, keep } = backupDir();
      await requirePassword(request);
      try {
        const created = await createBackup(ctx.db, { dir, keep, now: ctx.clock.now() });
        await audit(
          request,
          'backup.create',
          { type: 'backup', id: created.name },
          {
            bytes: created.bytes,
            sha256: created.sha256,
          },
        );
        return created;
      } catch (err) {
        if (err instanceof BackupError && err.message === 'busy') {
          throw new ApiError('conflict', { message: 'بکاپ دیگری همین حالا در حال ساخت است.' });
        }
        throw err;
      }
    },
  );

  app.get('/api/system/backups/:name', { config: { access: 'owner' } }, async (request, reply) => {
    const { dir } = backupDir();
    const { name } = parseInput(nameParam, request.params);
    const path = join(dir, name);
    if (!existsSync(path)) throw new ApiError('not_found');
    await audit(request, 'backup.download', { type: 'backup', id: name });
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(path));
  });

  done();
};
