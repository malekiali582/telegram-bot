import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { SqlSession } from './migrate.ts';
import { migrate } from './migrate.ts';
import * as schema from './schema.ts';

export type Schema = typeof schema;
/** Driver-independent database type used by all services. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  kind: 'postgres' | 'pglite';
  db: Database;
  /** A dedicated raw connection (migrations, advisory locks, tests). */
  session(): Promise<SqlSession>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  /** Pool size. */
  max?: number;
  applicationName?: string;
}

/** Production driver: node-postgres pool. Every session runs in UTC. */
export function connectPostgres(url: string, options: PostgresOptions = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'lulu',
    options: '-c timezone=UTC',
  });
  // An idle client that errors (e.g. server restart) must not crash the process.
  pool.on('error', () => {});

  return {
    kind: 'postgres',
    db: drizzleNodePg({ client: pool, schema }),
    async session() {
      const client = await pool.connect();
      return {
        exec: async (sql) => {
          await client.query(sql);
        },
        query: async <R>(sql: string, params?: unknown[]) =>
          (await client.query(sql, params)).rows as R[],
        release: () => {
          client.release();
          return Promise.resolve();
        },
      };
    },
    close: () => pool.end(),
  };
}

/** Applies pending migrations through a dedicated session. */
export async function migrateDatabase(handle: DatabaseHandle): Promise<{ applied: string[] }> {
  const session = await handle.session();
  try {
    return await migrate(session);
  } finally {
    await session.release();
  }
}
