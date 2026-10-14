import { parseGameConfig } from '@lulu/config';
import type { SaveConfigResult } from '@lulu/domain';
import {
  configVersionDetail,
  currentConfig,
  listConfigVersions,
  previewConfigChange,
  rollbackConfig,
  saveConfigVersion,
} from '@lulu/domain';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../app.ts';
import { PASSWORD_MAX_LENGTH } from '../auth/password.ts';
import { requirePassword } from '../auth/reauth.ts';
import { SECTION_TITLES, changeViews, configFields } from '../config-form.ts';
import type {
  ConfigFormView,
  ConfigPreviewView,
  ConfigVersionDetailView,
  ConfigVersionView,
} from '../contract.ts';
import { ApiError, parseInput } from '../errors.ts';

const configDoc = z.record(z.string(), z.unknown());
const password = z
  .string()
  .max(PASSWORD_MAX_LENGTH * 4)
  .optional();
const saveBody = z.object({
  config: configDoc,
  note: z.string().max(500),
  baseVersionId: z.number().int().positive(),
  password,
});
const rollbackBody = z.object({
  note: z.string().max(500),
  baseVersionId: z.number().int().positive(),
  password,
});
const idParam = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

const OWNER_ONLY = 'این تغییر به قانون‌های قطعی مالک دست می‌زند و فقط مالک می‌تواند آن را ثبت کند.';

export const configRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  /** Owner rules: the owner role and the re-entered password, checked here. */
  const approveOwnerRules = async (request: FastifyRequest, needsOwner: boolean, pw?: string) => {
    if (!needsOwner) return false;
    if (request.session!.admin.role !== 'owner') {
      throw new ApiError('forbidden', { message: OWNER_ONLY });
    }
    await requirePassword(deps, request, pw);
    return true;
  };

  const finish = (result: SaveConfigResult | { status: 'not_found' }) => {
    switch (result.status) {
      case 'ok':
        return { versionId: result.versionId, changes: result.changes.length };
      case 'invalid':
        throw new ApiError('invalid_request', {
          message: `تنظیمات معتبر نیست: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('؛ ')}`,
        });
      case 'note_required':
        throw new ApiError('invalid_request', { message: 'نوشتن توضیح تغییر الزامی است.' });
      case 'unchanged':
        throw new ApiError('invalid_request', { message: 'چیزی تغییر نکرده است.' });
      case 'stale':
        throw new ApiError('conflict', {
          message:
            'تنظیمات در این فاصله توسط کس دیگری تغییر کرده است. صفحه را تازه کنید و دوباره امتحان کنید.',
        });
      case 'needs_owner':
        throw new ApiError('forbidden', { message: OWNER_ONLY });
      case 'not_found':
        throw new ApiError('not_found', { message: 'این نسخه پیدا نشد.' });
    }
  };

  app.get('/api/config', { config: { access: 'admin' } }, async (): Promise<ConfigFormView> => {
    const { versionId, config, info } = await currentConfig(ctx);
    const fields = configFields(config);
    return {
      versionId,
      effectiveFrom: info.effectiveFrom.toISOString(),
      source: info.source,
      note: info.note,
      createdBy: info.createdBy,
      sections: Object.keys(config).map((key) => ({
        key,
        title: SECTION_TITLES[key] ?? key,
        fields: fields.filter((f) => f.section === key),
      })),
      config: config as unknown as Record<string, unknown>,
    };
  });

  app.post(
    '/api/config/preview',
    { config: { access: 'admin' } },
    async (request): Promise<ConfigPreviewView> => {
      const { config } = parseInput(z.object({ config: configDoc }), request.body);
      const result = await previewConfigChange(ctx, config);
      if (result.status === 'invalid') return result;
      return {
        status: 'ok',
        baseVersionId: result.baseVersionId,
        changes: changeViews(parseGameConfig(config), result.changes),
        needsOwner: result.needsOwner,
      };
    },
  );

  app.post('/api/config', { config: { access: 'admin' } }, async (request) => {
    const body = parseInput(saveBody, request.body);
    const preview = await previewConfigChange(ctx, body.config);
    const ownerApproved = await approveOwnerRules(
      request,
      preview.status === 'ok' && preview.needsOwner,
      body.password,
    );
    return finish(
      await saveConfigVersion(ctx, {
        config: body.config,
        note: body.note,
        baseVersionId: body.baseVersionId,
        adminUserId: request.session!.admin.id,
        ownerApproved,
        requestId: request.id,
      }),
    );
  });

  app.get(
    '/api/config/versions',
    { config: { access: 'admin' } },
    async (): Promise<ConfigVersionView[]> =>
      (await listConfigVersions(ctx)).map((v) => ({
        id: v.id,
        source: v.source,
        note: v.note,
        effectiveFrom: v.effectiveFrom.toISOString(),
        createdBy: v.createdBy,
        ownerApprovedBy: v.ownerApprovedBy,
        changeCount: v.changeCount,
        ownerRulesChanged: v.ownerRulesChanged,
        current: v.current,
      })),
  );

  app.get(
    '/api/config/versions/:id',
    { config: { access: 'admin' } },
    async (request): Promise<ConfigVersionDetailView> => {
      const { id } = parseInput(idParam, request.params);
      const d = await configVersionDetail(ctx, id);
      if (!d) throw new ApiError('not_found', { message: 'این نسخه پیدا نشد.' });
      return {
        id: d.info.id,
        source: d.info.source,
        note: d.info.note,
        effectiveFrom: d.info.effectiveFrom.toISOString(),
        createdBy: d.info.createdBy,
        ownerApprovedBy: d.info.ownerApprovedBy,
        changes: changeViews(d.config, d.changes),
      };
    },
  );

  app.post(
    '/api/config/versions/:id/rollback',
    { config: { access: 'admin' } },
    async (request) => {
      const { id } = parseInput(idParam, request.params);
      const body = parseInput(rollbackBody, request.body);
      const target = await configVersionDetail(ctx, id);
      if (!target) throw new ApiError('not_found', { message: 'این نسخه پیدا نشد.' });
      const preview = await previewConfigChange(ctx, target.config);
      const ownerApproved = await approveOwnerRules(
        request,
        preview.status === 'ok' && preview.needsOwner,
        body.password,
      );
      return finish(
        await rollbackConfig(ctx, {
          versionId: id,
          note: body.note,
          baseVersionId: body.baseVersionId,
          adminUserId: request.session!.admin.id,
          ownerApproved,
          requestId: request.id,
        }),
      );
    },
  );

  done();
};
