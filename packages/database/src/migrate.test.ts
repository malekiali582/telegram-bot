import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from './client.ts';
import type { Migration } from './migrate.ts';
import { checksum, loadMigrations, migrate, MigrationError } from './migrate.ts';
import * as schema from './schema.ts';
import type { TestDatabase } from './testing.ts';
import { createTestDatabase, testBackend } from './testing.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.close();
});

async function query<R>(sql: string, params?: unknown[]): Promise<R[]> {
  const session = await t.session();
  try {
    return await session.query<R>(sql, params);
  } finally {
    await session.release();
  }
}

describe(`migrations (${testBackend()})`, () => {
  it('loads migration files in order with stable checksums', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual([
      '0001_init',
      '0002_guards',
      '0003_system_wallets_default_config',
      '0004_ghost_message_refs',
      '0005_owner_rules_round2',
      '0006_daily_streaks',
      '0007_sample_markers',
      '0008_panel_monitoring',
      '0009_settlement_interval',
    ]);
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });

  it('applies every migration exactly once', async () => {
    const rows = await query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual([
      '0001_init',
      '0002_guards',
      '0003_system_wallets_default_config',
      '0004_ghost_message_refs',
      '0005_owner_rules_round2',
      '0006_daily_streaks',
      '0007_sample_markers',
      '0008_panel_monitoring',
      '0009_settlement_interval',
    ]);
    expect(await migrateDatabase(t)).toEqual({ applied: [] });
  });

  it('refuses to run when an applied migration was edited', async () => {
    const edited: Migration[] = loadMigrations().map((m, i) =>
      i === 0 ? { ...m, sql: `${m.sql}\n-- edit`, checksum: checksum(`${m.sql}\n-- edit`) } : m,
    );
    const session = await t.session();
    try {
      await expect(migrate(session, edited)).rejects.toThrow(MigrationError);
      await expect(migrate(session, edited)).rejects.toThrow(/edited after it was applied/);
    } finally {
      await session.release();
    }
  });

  it('refuses to run against a database from newer code', async () => {
    const session = await t.session();
    try {
      await expect(migrate(session, loadMigrations().slice(0, 1))).rejects.toThrow(/does not know/);
    } finally {
      await session.release();
    }
  });
});

describe('Drizzle schema matches the migrated database', () => {
  const tables = Object.values(schema as Record<string, unknown>).filter(
    (v): v is PgTable => v instanceof PgTable,
  );

  it('declares exactly the tables the migrations create', async () => {
    const rows = await query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    );
    const inDb = rows.map((r) => r.relname).sort();
    const inCode = tables.map((tbl) => getTableConfig(tbl).name).sort();
    expect(inCode).toEqual(inDb);
  });

  it('matches every column name, type and nullability', async () => {
    const rows = await query<{ table: string; column: string; type: string; notnull: boolean }>(
      `SELECT c.relname AS table, a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0
         AND NOT a.attisdropped AND c.relname <> 'schema_migrations'`,
    );
    const describeColumn = (type: string, notNull: boolean) =>
      `${type.replace(/\s+/g, '')}${notNull ? ' not null' : ''}`;
    const inDb = Object.fromEntries(
      rows.map((r) => [`${r.table}.${r.column}`, describeColumn(r.type, r.notnull)]),
    );
    const inCode = Object.fromEntries(
      tables.flatMap((tbl) => {
        const config = getTableConfig(tbl);
        return config.columns.map((col) => [
          `${config.name}.${col.name}`,
          describeColumn(col.getSQLType(), col.notNull),
        ]);
      }),
    );
    expect(inCode).toEqual(inDb);
  });
});
