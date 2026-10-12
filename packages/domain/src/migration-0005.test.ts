import { DEFAULT_GAME_CONFIG, FOOD_KINDS } from '@lulu/config';
import type { DatabaseHandle } from '@lulu/database';
import { loadMigrations, migrate, queryRows } from '@lulu/database';
import { openPglite } from '@lulu/database/pglite';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigProvider, ensureDefaultConfig } from './config-service.ts';

/**
 * Migration 0005 (owner rule changes of 2026-10-10) on a database that already holds
 * data in the old shape: the stored configuration must still parse, and running meals
 * and menu buttons are carried over as documented in the migration.
 */

type Doc = Record<string, unknown>;
interface OldConfig {
  food: Doc;
  foods: Record<string, Doc>;
  ghosts: Doc;
  levels: Doc[];
}

/** The version-1 defaults as they were stored before 0005. */
function oldDefaults(): OldConfig {
  const c = structuredClone(DEFAULT_GAME_CONFIG) as unknown as OldConfig;
  c.food = { pointsPerNutritionPerSecond: 5, mealDurationSeconds: 1800, claimWindowSeconds: 300 };
  for (const f of FOOD_KINDS) delete c.foods[f]!.pointsPerDeposit;
  for (const k of ['failureStepBp', 'dailyAttempts', 'rewardPerMember', 'memberActivityWindowDays'])
    delete c.ghosts[k];
  Object.assign(c.ghosts, {
    failureMultiplierBp: 9000,
    cooldownSeconds: 1800,
    fearMin: 10,
    fearMax: 30,
  });
  // Before 0008: no monitoring section, two-hour idle timeout.
  delete (c as unknown as Record<string, unknown>).monitoring;
  delete (c as unknown as Record<string, unknown>).settlement;
  (c as unknown as { admin: { sessionIdleMinutes: number } }).admin.sessionIdleMinutes = 120;
  return c;
}

let h: DatabaseHandle;
const all = loadMigrations();
const before = all.filter((m) => m.version < '0005');

async function run(migrations = all) {
  const session = await h.session();
  try {
    return await migrate(session, migrations);
  } finally {
    await session.release();
  }
}

beforeEach(async () => {
  h = await openPglite();
  await run(before);
});
afterEach(async () => {
  await h.close();
});

describe('migration 0005 on old data (pglite)', () => {
  it('rewrites stored configurations into the new shape, keeping suggested values', async () => {
    const old = oldDefaults();
    await h.db.execute(sql`INSERT INTO config_versions (config, source, note, effective_from)
      VALUES (${JSON.stringify(old)}::jsonb, 'default', 'v1', 'epoch')`);
    const tuned = structuredClone(old);
    tuned.levels[0]!.upgradeCost = 444;
    await h.db.execute(sql`INSERT INTO config_versions (config, source, note, effective_from)
      VALUES (${JSON.stringify(tuned)}::jsonb, 'panel', 'tuned', '2026-10-01T00:00:00Z')`);

    expect((await run()).applied).toEqual(
      all.filter((m) => m.version >= '0005').map((m) => m.version),
    );

    const provider = new ConfigProvider();
    const early = await provider.effectiveAt(h.db, new Date('2026-09-01T00:00:00Z'));
    expect(early.config).toEqual(DEFAULT_GAME_CONFIG);
    const late = await provider.effectiveAt(h.db, new Date('2026-10-05T00:00:00Z'));
    expect(late.config.levels[0]!.upgradeCost).toBe(444);
    expect(late.config.ghosts.rewardPerMember).toBe(50);
    expect(late.config.foods.deer.pointsPerDeposit).toBe(500);
    // 0008: the monitoring section is added everywhere; only the untouched default gets
    // the 30-minute idle timeout, a version chosen in the panel keeps its own value.
    expect(late.config.monitoring.inflationDailyWarnBp).toBe(1000);
    expect(late.config.settlement.periodicIntervalMinutes).toBe(60);
    expect(late.config.admin.sessionIdleMinutes).toBe(120);
    expect(early.config.admin.sessionIdleMinutes).toBe(30);
    expect(await ensureDefaultConfig(h.db)).toMatchObject({
      created: false,
      matchesCodeDefaults: true,
    });
  });

  it('lets old meals run out without new deposits, and revives old menu buttons', async () => {
    await h.db.execute(sql`INSERT INTO users (display_name) VALUES ('قدیمی')`);
    await h.db.execute(sql`INSERT INTO player_state (user_id) VALUES (1)`);
    await h.db.execute(sql`INSERT INTO food_effects
        (user_id, food, nutrition, points_per_second, started_at, expires_at)
      VALUES (1, 'bone', 1, 5, '2026-10-10T08:00:00Z', '2026-10-10T08:30:00Z')`);
    await h.db.execute(sql`INSERT INTO pending_confirmations
        (token, user_id, action, params, platform, chat_id, created_at, expires_at, used_at)
      VALUES ('menu-token-0000000001', 1, 'help', '{"batch":"x"}', 'telegram', '1',
              '2026-10-04T08:00:00Z', '2026-10-04T08:02:00Z', '2026-10-04T08:01:00Z'),
             ('conf-token-0000000001', 1, 'confirm', '{"batch":"y"}', 'telegram', '1',
              '2026-10-04T08:00:00Z', '2026-10-04T08:02:00Z', NULL)`);

    await run();

    const meals = await queryRows<{ deposits_paid: number; deposits_total: number }>(
      h.db,
      sql`SELECT deposits_paid, deposits_total FROM food_effects`,
    );
    expect(meals).toEqual([{ deposits_paid: 6, deposits_total: 6 }]);
    const buttons = await queryRows<{
      action: string;
      expires_at: Date | null;
      used_at: Date | null;
    }>(h.db, sql`SELECT action, expires_at, used_at FROM pending_confirmations ORDER BY action`);
    expect(buttons.map((b) => [b.action, b.expires_at === null, b.used_at === null])).toEqual([
      ['confirm', false, true],
      ['help', true, true],
    ]);
  });
});
