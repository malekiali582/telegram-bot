import type { GameConfig } from '@lulu/config';
import { configLeaves } from '@lulu/config';
import { auditLogs } from '@lulu/database';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame } from '@lulu/domain/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  ConfigFieldView,
  ConfigFormView,
  ConfigPreviewView,
  ConfigVersionDetailView,
  ConfigVersionView,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let owner: LoggedIn;
let helper: LoggedIn;
const PASSWORD = 'correct horse battery';

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  api = await createTestApi(game);
  await addAdmin(game, 'owner', 'owner');
  await addAdmin(game, 'helper', 'admin');
  owner = await loginAs(api, 'owner');
  helper = await loginAs(api, 'helper');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const get = async <T>(url: string, who = helper) => {
  const r = await api.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json<T>() };
};
const post = async <T>(url: string, payload: object, who = helper) => {
  const r = await api.app.inject({ method: 'POST', url, headers: who.writeHeaders, payload });
  return { status: r.statusCode, body: r.json<T>() };
};

async function form() {
  return (await get<ConfigFormView>('/api/config')).body;
}
/** A typed copy of the form's document, edited by `fn`. */
const edit = (config: Record<string, unknown>, fn: (c: GameConfig) => void) => {
  const copy = structuredClone(config) as unknown as GameConfig;
  fn(copy);
  return copy;
};

describe('economy settings form', () => {
  it('describes every config value from the schema, with labels, limits and Persian context', async () => {
    const f = await form();
    const fields = f.sections.flatMap((s) => s.fields);
    expect(fields).toHaveLength(configLeaves(f.config).length);
    expect(f.sections[0]).toMatchObject({ key: 'lolo', title: 'لولو' });
    const by = (path: string) => fields.find((x) => x.path === path)!;

    expect(by('levels[2].upgradeCost')).toMatchObject<Partial<ConfigFieldView>>({
      label: 'suggested',
      description: 'هزینهٔ رفتن به سطح بعد (پوینت)',
      context: 'سطح ۳ (زامبی)',
      kind: 'integer',
      min: 1,
      readOnly: false,
      value: 90_000,
    });
    expect(by('lolo.cooldownSeconds')).toMatchObject({ label: 'fixed', readOnly: false });
    expect(by('levels[0].level').readOnly).toBe(true);
    expect(by('levels[5].upgradeCost')).toMatchObject({ readOnly: true, value: null });
    expect(by('foods.human.requiredTool')).toMatchObject({
      kind: 'choice',
      nullable: true,
      value: 'magic_wand',
      context: 'انسان',
    });
    expect(by('foods.human.requiredTool').options).toContainEqual({
      value: 'magic_wand',
      name: 'چوب جادو',
    });
    expect(by('huntingGrounds[0].weightsBp.bone')).toMatchObject({
      basisPoints: true,
      context: 'سطح ۱ · استخوان',
    });
    expect(by('tools.knife.price').context).toBe('چاقو');
    expect(by('cemetery.upgradeCosts[1]')).toMatchObject({
      label: 'suggested',
      context: 'ارتقا به سطح ۲',
    });
    expect(by('curses.hunt_haste.levelCosts[0]').context).toBe('شتاب شکار · ارتقا به سطح ۱');
  });
});

describe('saving economy settings', () => {
  it('previews changes and explains invalid values in Persian', async () => {
    const f = await form();
    const ok = await post<ConfigPreviewView>('/api/config/preview', {
      config: edit(f.config, (c) => (c.tools.axe.price = 7_000)),
    });
    expect(ok.body).toMatchObject({ status: 'ok', needsOwner: false, baseVersionId: f.versionId });
    expect(ok.body.status === 'ok' && ok.body.changes).toEqual([
      {
        path: 'tools.axe.price',
        label: 'suggested',
        description: 'قیمت ابزار (پوینت)',
        context: 'تبر',
        before: 7_500,
        after: 7_000,
      },
    ]);
    const bad = await post<ConfigPreviewView>('/api/config/preview', {
      config: edit(f.config, (c) => (c.ghosts.dailyLimit = 50)),
    });
    expect(bad.body).toEqual({
      status: 'invalid',
      issues: [
        {
          path: 'ghosts.dailyLimit',
          message: 'سقف روح روزانه از تعداد تلاش‌های روزانه بیشتر است.',
        },
      ],
    });
  });

  it('lets an admin change suggested values, with a note, once per version', async () => {
    const f = await form();
    const cheaper = edit(f.config, (c) => (c.tools.axe.price = 7_000));
    const save = (note: string, base = f.versionId) =>
      post<ApiErrorBody>('/api/config', { config: cheaper, note, baseVersionId: base });
    expect((await save('')).status).toBe(400);
    expect((await save('ارزان‌تر')).status).toBe(200);
    const stale = await save('دوباره');
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain('تغییر کرده است');
    const now = await form();
    expect(now.versionId).not.toBe(f.versionId);
    const unchanged = await post<ApiErrorBody>('/api/config', {
      config: now.config,
      note: 'هیچ',
      baseVersionId: now.versionId,
    });
    expect(unchanged.body.error.message).toBe('چیزی تغییر نکرده است.');
  });

  it('lets only the owner change owner rules, after re-entering the password', async () => {
    const f = await form();
    const faster = edit(f.config, (c) => (c.lolo.cooldownSeconds = 240));
    const body = { config: faster, note: 'لولو سریع‌تر', baseVersionId: f.versionId };

    const byAdmin = await post<ApiErrorBody>('/api/config', { ...body, password: PASSWORD });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.message).toContain('فقط مالک');
    const noPassword = await post<ApiErrorBody>('/api/config', body, owner);
    expect(noPassword.body.error.code).toBe('wrong_password');
    expect((await post('/api/config', { ...body, password: 'wrong' }, owner)).status).toBe(403);
    expect((await post('/api/config', { ...body, password: PASSWORD }, owner)).status).toBe(200);

    const versions = await get<ConfigVersionView[]>('/api/config/versions');
    expect(versions.body[0]).toMatchObject({
      current: true,
      changeCount: 1,
      ownerRulesChanged: true,
      createdBy: 'owner',
      ownerApprovedBy: 'owner',
      note: 'لولو سریع‌تر',
    });
    const detail = await get<ConfigVersionDetailView>(
      `/api/config/versions/${versions.body[0]!.id}`,
    );
    expect(detail.body.changes).toEqual([
      expect.objectContaining({
        path: 'lolo.cooldownSeconds',
        label: 'fixed',
        before: 300,
        after: 240,
      }),
    ]);

    // Rolling back that change touches an owner rule again: owner only.
    const latest = await form();
    const back = { note: 'برگشت', baseVersionId: latest.versionId };
    expect((await post(`/api/config/versions/${f.versionId}/rollback`, back)).status).toBe(403);
    expect(
      (
        await post(
          `/api/config/versions/${f.versionId}/rollback`,
          { ...back, password: PASSWORD },
          owner,
        )
      ).status,
    ).toBe(200);
    expect((await form()).config).toEqual(f.config);
    expect((await get<ConfigVersionView[]>('/api/config/versions')).body).toHaveLength(3);
    const actions = (await game.ctx.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['config.update', 'config.rollback']));
    expect((await post('/api/config/versions/9999/rollback', back)).status).toBe(404);
  });
});
