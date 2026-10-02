import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import { configVersions, transactions } from '@lulu/database';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase, testBackend } from '@lulu/database/testing';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigProvider, ensureDefaultConfig } from './config-service.ts';
import { createDomainContext } from './context.ts';
import { claimLolo } from './lolo.ts';
import { registerGroup } from './groups.ts';
import { registerPlayer } from './players.ts';
import { TestClock, TestRng } from './testing.ts';

let t: TestDatabase;
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.close();
});

const versionCount = async () =>
  (await t.db.select({ n: count() }).from(configVersions))[0]?.n ?? 0;

describe(`initial configuration version (${testBackend()})`, () => {
  it('stores the code defaults once, however often it runs', async () => {
    const first = await ensureDefaultConfig(t.db);
    const second = await ensureDefaultConfig(t.db);
    expect(first).toMatchObject({ created: true, matchesCodeDefaults: true });
    expect(second).toEqual({
      versionId: first.versionId,
      created: false,
      matchesCodeDefaults: true,
    });
    expect(await versionCount()).toBe(1);

    const [row] = await t.db.select().from(configVersions);
    expect(row?.config).toEqual(DEFAULT_GAME_CONFIG);
    expect(row?.source).toBe('default');
  });

  it('creates exactly one row when 10 processes start at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureDefaultConfig(t.db)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    expect(await versionCount()).toBe(1);
  });

  it('never rewrites a stored default; it reports drift from the code instead', async () => {
    await ensureDefaultConfig(t.db);
    const changed = structuredClone(DEFAULT_GAME_CONFIG);
    changed.tools.knife.price = 999;
    const result = await ensureDefaultConfig(t.db, changed);
    expect(result).toMatchObject({ created: false, matchesCodeDefaults: false });
    const [row] = await t.db.select().from(configVersions);
    expect(row?.config).toEqual(DEFAULT_GAME_CONFIG);
  });

  it('rejects invalid defaults before touching the database', async () => {
    const broken = structuredClone(DEFAULT_GAME_CONFIG);
    broken.huntingGrounds[0]!.weightsBp.bone = 1;
    await expect(ensureDefaultConfig(t.db, broken)).rejects.toThrow();
    expect(await versionCount()).toBe(0);
  });
});

describe('effective configuration', () => {
  it('fails clearly when no version exists', async () => {
    await expect(new ConfigProvider().effectiveAt(t.db, new Date())).rejects.toThrow(
      /ensureDefaultConfig/,
    );
  });

  it('uses the version in force at the instant; later versions do not apply backwards', async () => {
    const { versionId: v1 } = await ensureDefaultConfig(t.db);
    const changed = structuredClone(DEFAULT_GAME_CONFIG);
    changed.tools.knife.price = 600;
    const [v2] = await t.db
      .insert(configVersions)
      .values({ config: changed, source: 'panel', effectiveFrom: new Date('2026-10-05T00:00:00Z') })
      .returning({ id: configVersions.id });

    const provider = new ConfigProvider();
    const before = await provider.effectiveAt(t.db, new Date('2026-10-04T23:59:59Z'));
    const after = await provider.effectiveAt(t.db, new Date('2026-10-05T00:00:00Z'));
    expect([before.versionId, before.config.tools.knife.price]).toEqual([v1, 500]);
    expect([after.versionId, after.config.tools.knife.price]).toEqual([v2!.id, 600]);
  });

  it('records the version each operation ran with', async () => {
    const { versionId } = await ensureDefaultConfig(t.db);
    const ctx = createDomainContext(t.db, {
      clock: new TestClock('2026-10-02T08:00:00Z'),
      rng: new TestRng(),
    });
    const player = await registerPlayer(ctx, {
      platform: 'telegram',
      platformUserId: '7',
      displayName: 'x',
    });
    const { groupId } = await registerGroup(ctx, {
      platform: 'telegram',
      platformChatId: '-7',
      title: 'g',
    });
    if (player.status !== 'ok') throw new Error('registration failed');
    const result = await claimLolo(ctx, { userId: player.userId, groupId });
    if (result.status !== 'ok') throw new Error('lolo failed');
    const [row] = await t.db
      .select({ configVersionId: transactions.configVersionId })
      .from(transactions)
      .where(eq(transactions.id, result.transactionId));
    expect(row?.configVersionId).toBe(versionId);
  });
});
