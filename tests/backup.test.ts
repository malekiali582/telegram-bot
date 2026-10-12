/**
 * Logical backup (apps/api/src/backup.ts): a full round trip on data made by the real
 * game services, and every refusal. Runs on PGlite and on real PostgreSQL.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
import type { DatabaseHandle } from '@lulu/database';
import { configVersions, loadMigrations, queryRows } from '@lulu/database';
import { openPglite } from '@lulu/database/pglite';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase } from '@lulu/database/testing';
import { ensureDefaultConfig } from '@lulu/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupResult } from '@lulu/api';
import {
  BackupError,
  createAdminUser,
  createBackup,
  createSession,
  listBackups,
  readBackupHeader,
  restoreBackup,
} from '@lulu/api';
import { seedSampleData } from '../scripts/panel-dev/seed.ts';

const NOW = new Date('2026-10-12T14:00:00Z');
let source: TestDatabase;
let dir: string;
let backup: BackupResult;
const open: DatabaseHandle[] = [];

async function fingerprints(handle: DatabaseHandle, tables: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const [row] = await queryRows<{ h: string }>(
      handle.db,
      sql.raw(
        `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS h FROM "${t}" t`,
      ),
    );
    out[t] = row!.h;
  }
  return out;
}

async function freshTarget(): Promise<TestDatabase> {
  const t = await createTestDatabase();
  open.push(t);
  return t;
}

beforeAll(async () => {
  source = await createTestDatabase();
  open.push(source);
  await ensureDefaultConfig(source.db);
  await seedSampleData(source.db, { players: 8, groups: 4, days: 4, now: NOW });
  const admin = await createAdminUser(source.db, {
    username: 'owner',
    password: 'correct horse battery',
    role: 'owner',
    now: NOW,
  });
  if (admin.status !== 'ok') throw new Error('setup');
  await createSession(source.db, {
    adminUserId: admin.adminUserId,
    secret: 's'.repeat(32),
    now: NOW,
    ttlMs: 3_600_000,
    ip: '127.0.0.1',
    userAgent: undefined,
  });
  await source.db.insert(configVersions).values({
    config: DEFAULT_GAME_CONFIG,
    source: 'panel',
    note: 'بدون تغییر',
    effectiveFrom: NOW,
    createdByAdminId: admin.adminUserId,
  });
  dir = mkdtempSync(join(tmpdir(), 'lulu-backup-'));
  backup = await createBackup(source.db, { dir, now: NOW, keep: 3 });
}, 240_000);

afterAll(async () => {
  for (const h of open) await h.close();
});

describe('logical backup', () => {
  it('writes every data table in dependency order, without sessions', async () => {
    expect(backup.name).toBe('lulu-backup-20261012-140000Z.jsonl.gz');
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    const header = await readBackupHeader(join(dir, backup.name));
    expect(header.tables.indexOf('users')).toBeLessThan(header.tables.indexOf('wallets'));
    expect(header.tables.indexOf('transactions')).toBeLessThan(
      header.tables.indexOf('ledger_entries'),
    );
    expect(header.tables).not.toContain('admin_sessions');
    expect(header.tables).not.toContain('schema_migrations');
    expect(header.migrations.at(-1)?.version).toBe(loadMigrations().at(-1)?.version);
    expect(backup.rows.ledger_entries).toBeGreaterThan(100);
  });

  it('restores into a fresh database exactly, with triggers and counters working again', async () => {
    const target = await freshTarget();
    const result = await restoreBackup(target, join(dir, backup.name), { replaceExisting: false });
    expect(result.rows).toEqual(backup.rows);
    expect(result.migratedAfter).toEqual([]);

    const header = await readBackupHeader(join(dir, backup.name));
    expect(await fingerprints(target, header.tables)).toEqual(
      await fingerprints(source, header.tables),
    );
    const [sessions] = await queryRows<{ n: number }>(
      target.db,
      sql`SELECT count(*)::int AS n FROM admin_sessions`,
    );
    expect(sessions!.n).toBe(0);

    // Identity counters continue after the restored ids.
    const [max] = await queryRows<{ id: number }>(
      target.db,
      sql`SELECT max(id)::int AS id FROM users`,
    );
    const [added] = await queryRows<{ id: number }>(
      target.db,
      sql`INSERT INTO users (display_name) VALUES ('تازه') RETURNING id::int`,
    );
    expect(added!.id).toBe(max!.id + 1);
    // The money guards are back on.
    await expect(
      target.db.execute(sql`UPDATE wallets SET balance = balance + 1 WHERE kind = 'user_cash'`),
    ).rejects.toThrow();
    await expect(target.db.execute(sql`DELETE FROM ledger_entries`)).rejects.toThrow();
  });

  it('also restores into a database that was never migrated', async () => {
    const empty = await openPglite();
    open.push(empty);
    const result = await restoreBackup(empty, join(dir, backup.name), { replaceExisting: false });
    expect(result.rows.users).toBe(backup.rows.users);
  });

  it('replaces existing data only when asked', async () => {
    const target = await freshTarget();
    await target.db.execute(sql`INSERT INTO users (display_name) VALUES ('موجود')`);
    await expect(
      restoreBackup(target, join(dir, backup.name), { replaceExisting: false }),
    ).rejects.toThrow(/already has data/);
    await restoreBackup(target, join(dir, backup.name), { replaceExisting: true });
    const [n] = await queryRows<{ n: number }>(
      target.db,
      sql`SELECT count(*)::int AS n FROM users`,
    );
    expect(n!.n).toBe(backup.rows.users);
  });

  it('rolls back completely on a truncated file', async () => {
    const lines = gunzipSync(readFileSync(join(dir, backup.name)))
      .toString('utf8')
      .split('\n');
    const cut = join(dir, 'cut.jsonl.gz');
    writeFileSync(cut, gzipSync(lines.filter((l) => !l.startsWith('#end')).join('\n')));

    const target = await freshTarget();
    await target.db.execute(sql`INSERT INTO users (display_name) VALUES ('موجود')`);
    await expect(restoreBackup(target, cut, { replaceExisting: true })).rejects.toThrow(
      /incomplete/,
    );
    const names = await queryRows<{ display_name: string }>(
      target.db,
      sql`SELECT display_name FROM users`,
    );
    expect(names).toEqual([{ display_name: 'موجود' }]);
  });

  it('refuses foreign files, unknown tables and databases ahead of the backup', async () => {
    const other = join(dir, 'other.gz');
    writeFileSync(other, gzipSync('hello\n'));
    const target = await freshTarget();
    await expect(restoreBackup(target, other, { replaceExisting: true })).rejects.toThrow(
      BackupError,
    );

    const lines = gunzipSync(readFileSync(join(dir, backup.name)))
      .toString('utf8')
      .split('\n');
    const forged = join(dir, 'forged.jsonl.gz');
    lines.splice(1, 0, 'pg_authid\t[]');
    writeFileSync(forged, gzipSync(lines.join('\n')));
    await expect(restoreBackup(target, forged, { replaceExisting: true })).rejects.toThrow(
      /unexpected line/,
    );

    await target.db.execute(
      sql`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_future', 'x')`,
    );
    await expect(
      restoreBackup(target, join(dir, backup.name), { replaceExisting: true }),
    ).rejects.toThrow(/newer schema/);
  });

  it('keeps only the newest backups', async () => {
    for (let i = 1; i <= 3; i++) {
      await createBackup(source.db, { dir, now: new Date(NOW.getTime() + i * 1000), keep: 3 });
    }
    const again = await createBackup(source.db, {
      dir,
      now: new Date(NOW.getTime() + 3000),
      keep: 3,
    });
    expect(again.name).toBe('lulu-backup-20261012-140003Z-2.jsonl.gz');
    expect(listBackups(dir).map((b) => b.name)).toEqual([
      'lulu-backup-20261012-140003Z-2.jsonl.gz',
      'lulu-backup-20261012-140003Z.jsonl.gz',
      'lulu-backup-20261012-140002Z.jsonl.gz',
    ]);
  });
});
