import type { GameConfig } from '@lulu/config';
import { configIssues } from '@lulu/config';
import { auditLogs, configVersions } from '@lulu/database';
import { usingRealPostgres } from '@lulu/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configVersionDetail,
  currentConfig,
  listConfigVersions,
  previewConfigChange,
  rollbackConfig,
  saveConfigVersion,
} from './config-admin.ts';
import { upgradeLevel } from './levels.ts';
import type { TestGame } from './testing.ts';
import { createAdminUser, createTestGame, grantPoints, newPlayer } from './testing.ts';

let game: TestGame;
let admin: number;
let owner: number;
beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  admin = await createAdminUser(game, 'admin');
  owner = await createAdminUser(game, 'owner');
});
afterEach(async () => {
  await game.close();
});

const edited = async (edit: (c: GameConfig) => void) => {
  const { config } = await currentConfig(game.ctx);
  const copy = structuredClone(config);
  edit(copy);
  return copy;
};

describe('economy settings', () => {
  it('preview: lists the changes, flags owner rules, explains invalid input in Persian', async () => {
    const suggested = await edited((c) => {
      c.levels[0]!.upgradeCost = 250;
    });
    const p1 = await previewConfigChange(game.ctx, suggested);
    expect(p1).toMatchObject({ status: 'ok', needsOwner: false });
    expect(p1.status === 'ok' && p1.changes).toEqual([
      { path: 'levels[0].upgradeCost', label: 'suggested', before: 300, after: 250 },
    ]);

    const fixed = await edited((c) => {
      c.lolo.cooldownSeconds = 240;
    });
    expect(await previewConfigChange(game.ctx, fixed)).toMatchObject({
      status: 'ok',
      needsOwner: true,
    });

    const broken = await edited((c) => {
      c.levels[0]!.rewardMin = 99;
      c.tools.knife.successBp = 20_000;
    });
    const p3 = await previewConfigChange(game.ctx, broken);
    expect(p3.status).toBe('invalid');
    expect(p3.status === 'invalid' && p3.issues).toEqual(
      expect.arrayContaining([
        { path: 'tools.knife.successBp', message: 'باید حداکثر 10000 باشد.' },
        { path: 'levels[0].rewardMin', message: 'کمینهٔ پاداش از بیشینه بزرگ‌تر است.' },
      ]),
    );
    expect(configIssues({})).not.toEqual([]);
  });

  it('save: needs a note, refuses stale or empty edits, and needs the owner for owner rules', async () => {
    const { versionId: base } = await currentConfig(game.ctx);
    const cheaper = await edited((c) => {
      c.levels[0]!.upgradeCost = 100;
    });
    const save = (config: unknown, extra: Partial<Parameters<typeof saveConfigVersion>[1]> = {}) =>
      saveConfigVersion(game.ctx, {
        config,
        note: 'ارزان‌تر برای تازه‌واردها',
        baseVersionId: base,
        adminUserId: admin,
        ownerApproved: false,
        ...extra,
      });

    expect(await save(cheaper, { note: '  ' })).toEqual({ status: 'note_required' });
    expect(await save(await edited(() => {}))).toEqual({ status: 'unchanged' });
    const ok = await save(cheaper);
    expect(ok).toMatchObject({ status: 'ok' });
    // The admin started from the old version: a second save on top of it is refused.
    expect(await save(cheaper)).toMatchObject({ status: 'stale' });

    // In force at once: a player's level upgrade now costs 100.
    const p = await newPlayer(game);
    await grantPoints(game, p, 150);
    expect((await upgradeLevel(game.ctx, { userId: p, expectedLevel: 1 })).status).toBe('ok');

    const { versionId: v2 } = await currentConfig(game.ctx);
    const fixed = await edited((c) => {
      c.lolo.cooldownSeconds = 240;
    });
    const refused = await save(fixed, { baseVersionId: v2 });
    expect(refused).toMatchObject({ status: 'needs_owner' });
    const approved = await save(fixed, {
      baseVersionId: v2,
      adminUserId: owner,
      ownerApproved: true,
    });
    expect(approved).toMatchObject({ status: 'ok' });

    const rows = await game.ctx.db.select().from(configVersions);
    const last = rows.find((r) => approved.status === 'ok' && r.id === approved.versionId)!;
    expect(last).toMatchObject({
      source: 'panel',
      createdByAdminId: owner,
      ownerApprovedByAdminId: owner,
    });
    const audit = await game.ctx.db.select().from(auditLogs);
    expect(audit.map((a) => a.action)).toEqual(['config.update', 'config.update']);
    expect(audit[1]!.details).toMatchObject({
      ownerRules: true,
      changes: [{ path: 'lolo.cooldownSeconds', label: 'fixed', before: 300, after: 240 }],
    });
  });

  it('history: newest first with changes; rollback adds a version and keeps the history', async () => {
    const v1 = (await currentConfig(game.ctx)).versionId;
    const r = await saveConfigVersion(game.ctx, {
      config: await edited((c) => {
        c.tools.knife.price = 400;
        c.tools.axe.price = 7_000;
      }),
      note: 'ابزار ارزان',
      baseVersionId: v1,
      adminUserId: admin,
      ownerApproved: false,
    });
    if (r.status !== 'ok') throw new Error(r.status);

    let list = await listConfigVersions(game.ctx);
    expect(list.map((v) => [v.source, v.changeCount, v.current])).toEqual([
      ['panel', 2, true],
      ['default', 0, false],
    ]);
    expect(list[0]).toMatchObject({ note: 'ابزار ارزان', ownerRulesChanged: false });
    const detail = await configVersionDetail(game.ctx, r.versionId);
    expect(detail!.changes.map((c) => c.path).sort()).toEqual([
      'tools.axe.price',
      'tools.knife.price',
    ]);
    expect(await configVersionDetail(game.ctx, 9999)).toBeNull();

    const back = await rollbackConfig(game.ctx, {
      versionId: v1,
      note: 'برگشت',
      baseVersionId: r.versionId,
      adminUserId: admin,
      ownerApproved: false,
    });
    expect(back).toMatchObject({ status: 'ok' });
    const now = await currentConfig(game.ctx);
    expect(now.config.tools.knife.price).toBe(500);
    list = await listConfigVersions(game.ctx);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ current: true, changeCount: 2 });
    const [audit] = (await game.ctx.db.select().from(auditLogs)).filter(
      (a) => a.action === 'config.rollback',
    );
    expect(audit!.details).toMatchObject({ restoredVersionId: v1 });
    expect(
      await rollbackConfig(game.ctx, {
        versionId: 9999,
        note: 'x',
        baseVersionId: 1,
        adminUserId: admin,
        ownerApproved: false,
      }),
    ).toEqual({ status: 'not_found' });
  });
});

describe.runIf(usingRealPostgres)('economy settings under concurrency (real PostgreSQL)', () => {
  it('lets only one of several simultaneous saves from the same version through', async () => {
    const { versionId } = await currentConfig(game.ctx);
    // Documents prepared first, so the saves themselves race.
    const docs = await Promise.all(
      [101, 102, 103, 104, 105, 106, 107, 108].map((cost) =>
        edited((c) => {
          c.levels[0]!.upgradeCost = cost;
        }),
      ),
    );
    const results = await Promise.all(
      docs.map((config, i) =>
        saveConfigVersion(game.ctx, {
          config,
          note: `هم‌زمان ${i}`,
          baseVersionId: versionId,
          adminUserId: admin,
          ownerApproved: false,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'stale')).toHaveLength(7);
    expect(await game.ctx.db.select().from(configVersions)).toHaveLength(2);
  });
});
