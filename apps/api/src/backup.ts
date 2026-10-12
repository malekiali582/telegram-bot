import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Database, DatabaseHandle, SqlSession } from '@lulu/database';
import { loadMigrations, migrate, queryRows } from '@lulu/database';
import { sql } from 'drizzle-orm';

/**
 * Logical backup that works wherever the app runs (embedded PostgreSQL in development,
 * any server), without pg_dump. On the server, pg_dump is the primary backup
 * (scripts/server/pg-backup.sh, docs/backup.md); this one is what the panel offers.
 *
 * File: gzip of text lines.
 *   #lulu-backup<TAB>{header JSON: format, version, createdAt, migrations, tables}
 *   <table><TAB>[row JSON, …]          up to 500 rows per line, tables in FK order
 *   #end<TAB>{"rows": {table: count}}  missing = the file is incomplete
 *
 * Rows are rendered by PostgreSQL (`row_to_json`) and restored by PostgreSQL
 * (`json_populate_recordset`); JavaScript never parses them, so numeric(78,0) money and
 * every other type round-trip exactly. Everything is read in one REPEATABLE READ
 * snapshot, so the backup is consistent while the game keeps running.
 *
 * Sessions, login attempts and heartbeats are not backed up: restoring them would
 * revive old logins or show dead processes.
 */

export const BACKUP_FORMAT = 'lulu-logical-backup';
const BACKUP_VERSION = 1;
const CHUNK_ROWS = 500;
const EXCLUDED_TABLES = new Set([
  'schema_migrations',
  'admin_sessions',
  'admin_login_attempts',
  'service_heartbeats',
]);
const BACKUP_LOCK = 4_727_101;
const NAME_PATTERN = /^lulu-backup-\d{8}-\d{6}Z(-\d{1,3})?\.jsonl\.gz$/;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  migrations: { version: string; checksum: string }[];
  tables: string[];
}

export class BackupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupError';
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Data tables of the public schema, parents before children (foreign keys). */
async function tablesInDependencyOrder(
  query: <R>(text: string) => Promise<R[]>,
): Promise<string[]> {
  const tables = (
    await query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    )
  ).map((t) => t.name);
  const edges = await query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.contype = 'f' AND n.nspname = 'public' AND c.oid <> p.oid`,
  );
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) parents.get(e.child)?.add(e.parent);
  const ordered: string[] = [];
  const done = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (t) => !done.has(t) && [...parents.get(t)!].every((p) => done.has(p)),
    );
    if (ready.length === 0) throw new BackupError('foreign keys form a cycle; cannot order tables');
    for (const t of ready) {
      ordered.push(t);
      done.add(t);
    }
  }
  return ordered.filter((t) => !EXCLUDED_TABLES.has(t));
}

/** `lulu-backup-20261012-153000Z.jsonl.gz` (UTC); `-2`, `-3` … if that second is taken. */
export function backupFileName(now: Date, dir?: string): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}Z`;
  for (let n = 1; n < 1000; n++) {
    const name = `lulu-backup-${stamp}${n === 1 ? '' : `-${n}`}.jsonl.gz`;
    if (!dir || (!existsSync(join(dir, name)) && !existsSync(join(dir, `${name}.partial`)))) {
      return name;
    }
  }
  throw new BackupError('too many backups in one second');
}

export const isBackupFileName = (name: string) => NAME_PATTERN.test(name);

/** Newest first: by timestamp, then by the same-second counter (no suffix = 1). */
function newestFirst(a: string, b: string): number {
  const key = (name: string) => {
    const digits = name.replace(/[^0-9]/g, ''); // yyyymmdd hhmmss [n]
    return [digits.slice(0, 14), Number(digits.slice(14) || 1)] as const;
  };
  const [stampA, nA] = key(a);
  const [stampB, nB] = key(b);
  return stampB.localeCompare(stampA) || nB - nA;
}

export interface BackupFile {
  name: string;
  bytes: number;
  createdAt: string;
}

export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(isBackupFileName)
    .map((name) => {
      const stat = statSync(join(dir, name));
      return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => newestFirst(a.name, b.name));
}

export interface BackupResult extends BackupFile {
  sha256: string;
  rows: Record<string, number>;
}

/**
 * Writes a backup into `dir`, then keeps only the newest `keep` backups there.
 * Throws BackupError('busy') when another backup is being written.
 */
export async function createBackup(
  db: Database,
  options: { dir: string; now: Date; keep: number },
): Promise<BackupResult> {
  mkdirSync(options.dir, { recursive: true });
  const name = backupFileName(options.now, options.dir);
  const path = join(options.dir, name);
  const partial = `${path}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const rows: Record<string, number> = {};

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      const [lock] = await queryRows<{ ok: boolean }>(
        tx,
        sql`SELECT pg_try_advisory_xact_lock(${BACKUP_LOCK}) AS ok`,
      );
      if (!lock?.ok) throw new BackupError('busy');
      const query = <R>(text: string) => queryRows<R>(tx, sql.raw(text));

      const header: BackupHeader = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: options.now.toISOString(),
        migrations: await query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version',
        ),
        tables: await tablesInDependencyOrder(query),
      };

      const gzip = createGzip({ level: 6 });
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          bytes += chunk.length;
          done(null, chunk);
        },
      });
      const written = pipeline(gzip, tap, createWriteStream(partial, { flags: 'wx' }));
      const write = (line: string) =>
        new Promise<void>((resolve, reject) => {
          if (gzip.write(`${line}\n`)) resolve();
          else gzip.once('drain', resolve).once('error', reject);
        });

      await write(`#lulu-backup\t${JSON.stringify(header)}`);
      for (const table of header.tables) {
        rows[table] = 0;
        await tx.execute(
          sql.raw(
            `DECLARE lulu_backup NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${ident(table)} t`,
          ),
        );
        for (;;) {
          const chunk = await query<{ j: string }>(`FETCH ${CHUNK_ROWS} FROM lulu_backup`);
          if (chunk.length === 0) break;
          rows[table] += chunk.length;
          await write(`${table}\t[${chunk.map((r) => r.j).join(',')}]`);
        }
        await tx.execute(sql.raw('CLOSE lulu_backup'));
      }
      await write(`#end\t${JSON.stringify({ rows })}`);
      gzip.end();
      await written;
    });
    renameSync(partial, path);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }

  for (const old of listBackups(options.dir).slice(Math.max(1, options.keep))) {
    rmSync(join(options.dir, old.name), { force: true });
  }
  const stat = statSync(path);
  return { name, bytes, createdAt: stat.mtime.toISOString(), sha256: hash.digest('hex'), rows };
}

// ───────────────────────── restore ─────────────────────────

async function* backupLines(file: string): AsyncGenerator<string> {
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) if (line !== '') yield line;
}

export async function readBackupHeader(file: string): Promise<BackupHeader> {
  for await (const line of backupLines(file)) {
    const [tag, json] = splitLine(line);
    if (tag !== '#lulu-backup') break;
    const header = JSON.parse(json) as BackupHeader;
    if (header.format !== BACKUP_FORMAT || header.version !== BACKUP_VERSION) break;
    return header;
  }
  throw new BackupError('not a LULU backup file (or an unsupported version)');
}

function splitLine(line: string): [string, string] {
  const tab = line.indexOf('\t');
  return tab < 0 ? [line, ''] : [line.slice(0, tab), line.slice(tab + 1)];
}

export interface RestoreResult {
  rows: Record<string, number>;
  /** Migrations newer than the backup, applied after the data was restored. */
  migratedAfter: string[];
}

/**
 * Restores a backup into `handle`'s database, replacing all its data:
 * 1. the database is migrated up to exactly the backup's schema version (a database
 *    already ahead of the backup is refused: restore into an empty database instead);
 * 2. in one transaction, triggers are paused, every data table is emptied, the rows are
 *    inserted, identity counters are reset, triggers are restored, and the ledger is
 *    checked (every balance equals its entries; all entries sum to zero);
 * 3. migrations newer than the backup are applied.
 * Anything wrong, including a truncated file, rolls the whole restore back.
 */
export async function restoreBackup(
  handle: DatabaseHandle,
  file: string,
  options: { replaceExisting: boolean },
): Promise<RestoreResult> {
  const header = await readBackupHeader(file);
  const known = loadMigrations();
  for (const [i, m] of header.migrations.entries()) {
    const code = known[i];
    if (!code || code.version !== m.version || code.checksum !== m.checksum) {
      throw new BackupError(`backup schema ${m.version} does not match this code's migrations`);
    }
  }
  const backupVersion = header.migrations.at(-1)?.version ?? '';

  const session = await handle.session();
  try {
    await session.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await session.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    if (applied.some((a) => a.version > backupVersion)) {
      throw new BackupError(
        `the database is at a newer schema than the backup (${backupVersion}); restore into an empty database`,
      );
    }
    await migrate(
      session,
      known.filter((m) => m.version <= backupVersion),
    );

    const [{ n } = { n: 0 }] = await session.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM users) + (SELECT count(*) FROM admin_users)
               + (SELECT count(*) FROM transactions))::int AS n`,
    );
    if (n > 0 && !options.replaceExisting) {
      throw new BackupError('the database already has data; confirm replacing it');
    }

    const rows = await restoreData(session, file, header);
    const after = await migrate(session, known);
    return { rows, migratedAfter: after.applied };
  } finally {
    await session.release();
  }
}

async function restoreData(
  session: SqlSession,
  file: string,
  header: BackupHeader,
): Promise<Record<string, number>> {
  const all = (
    await session.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    )
  ).map((t) => t.name);
  const allowed = new Set(header.tables);
  for (const t of header.tables) {
    if (!all.includes(t)) throw new BackupError(`backup table ${t} does not exist here`);
  }

  const rows: Record<string, number> = Object.fromEntries(header.tables.map((t) => [t, 0]));
  let footer: Record<string, number> | null = null;
  await session.exec('BEGIN');
  try {
    for (const t of all) await session.exec(`ALTER TABLE ${ident(t)} DISABLE TRIGGER USER`);
    await session.exec(`TRUNCATE ${all.map(ident).join(', ')} RESTART IDENTITY CASCADE`);

    for await (const line of backupLines(file)) {
      const [tag, payload] = splitLine(line);
      if (tag === '#lulu-backup') continue;
      if (tag === '#end') {
        footer = (JSON.parse(payload) as { rows: Record<string, number> }).rows;
        break;
      }
      // The file is data: only known table names are accepted, and the statement is ours.
      if (!allowed.has(tag)) throw new BackupError(`unexpected line for «${tag.slice(0, 40)}»`);
      const [result] = await session.query<{ n: number }>(
        `WITH ins AS (INSERT INTO ${ident(tag)} OVERRIDING SYSTEM VALUE
           SELECT * FROM json_populate_recordset(NULL::${ident(tag)}, $1::json) RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
        [payload],
      );
      rows[tag] = (rows[tag] ?? 0) + (result?.n ?? 0);
    }
    if (!footer) throw new BackupError('the backup file is incomplete (no end marker)');
    for (const t of header.tables) {
      if ((rows[t] ?? 0) !== (footer[t] ?? 0)) {
        throw new BackupError(`row count of ${t} does not match the backup's own count`);
      }
    }

    // Identity counters continue after the restored ids.
    const identities = await session.query<{ table: string; column: string }>(
      `SELECT c.relname AS table, a.attname AS column FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attidentity IN ('a', 'd') AND NOT a.attisdropped`,
    );
    for (const { table, column } of identities) {
      await session.query(
        `SELECT setval(pg_get_serial_sequence($1, $2),
                       coalesce((SELECT max(${ident(column)}) FROM ${ident(table)}), 0) + 1, false)`,
        [ident(table), column],
      );
    }
    for (const t of all) await session.exec(`ALTER TABLE ${ident(t)} ENABLE TRIGGER USER`);

    const [check] = await session.query<{ total: string; mismatched: number }>(
      `SELECT (SELECT coalesce(sum(amount), 0)::text FROM ledger_entries) AS total,
              (SELECT count(*)::int FROM wallets w WHERE w.kind <> 'system' AND w.balance <>
                 (SELECT coalesce(sum(amount), 0) FROM ledger_entries e WHERE e.wallet_id = w.id))
                AS mismatched`,
    );
    if (check?.total !== '0' || check.mismatched !== 0) {
      throw new BackupError('the restored ledger does not balance; nothing was changed');
    }
    await session.exec('COMMIT');
  } catch (err) {
    await session.exec('ROLLBACK');
    throw err;
  }
  return rows;
}
