import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One dedicated connection; needed so the session-level advisory lock holds throughout. */
export interface SqlSession {
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  query<R>(sql: string, params?: unknown[]): Promise<R[]>;
  release(): Promise<void>;
}

export interface Migration {
  /** File name without extension, e.g. `0001_init`. */
  version: string;
  sql: string;
  checksum: string;
}

/** Works from both `src/` (tests, dev) and `dist/` (production): both sit next to `migrations/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;
// Arbitrary constant shared by every LULU process that migrates.
const ADVISORY_LOCK_KEY = 4_727_001;

export function checksum(sql: string): string {
  // Line endings are normalized so a Windows checkout cannot look like an edited migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .map((file) => FILE_PATTERN.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const sql = readFileSync(`${dir}/${m[0]}`, 'utf8');
      return { version: m[1] ?? m[0], sql, checksum: checksum(sql) };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Applies pending migrations in order, each in its own transaction. Concurrent callers
 * serialize on an advisory lock. Refuses to run if an applied migration file was edited.
 */
export async function migrate(
  session: SqlSession,
  migrations: Migration[] = loadMigrations(),
): Promise<{ applied: string[] }> {
  await session.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  await session.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    const rows = await session.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const known = new Set(migrations.map((m) => m.version));

    for (const version of done.keys()) {
      if (!known.has(version)) {
        throw new MigrationError(`database has migration ${version} that this code does not know`);
      }
    }

    const applied: string[] = [];
    for (const m of migrations) {
      const recorded = done.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) {
          throw new MigrationError(
            `migration ${m.version} was edited after it was applied; add a new migration instead`,
          );
        }
        continue;
      }
      await session.exec('BEGIN');
      try {
        await session.exec(m.sql);
        await session.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          m.version,
          m.checksum,
        ]);
        await session.exec('COMMIT');
      } catch (err) {
        await session.exec('ROLLBACK');
        throw new MigrationError(`migration ${m.version} failed`, { cause: err });
      }
      applied.push(m.version);
    }
    return { applied };
  } finally {
    await session.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
