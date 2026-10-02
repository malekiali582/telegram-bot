import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { Database, DatabaseHandle } from './client.ts';
import * as schema from './schema.ts';

/**
 * PGlite: PostgreSQL compiled to WebAssembly, in-process and single-connection.
 * Used for fast tests and tooling. Not a substitute for real PostgreSQL in
 * concurrency testing (see docs/assumptions.md).
 */
export async function openPglite(options: { dataDir?: string } = {}): Promise<DatabaseHandle> {
  const client = new PGlite(options.dataDir);
  await client.waitReady;
  await client.exec(`SET TIME ZONE 'UTC'`);

  return {
    kind: 'pglite',
    db: drizzlePglite({ client, schema }) as unknown as Database,
    session() {
      return Promise.resolve({
        exec: async (sql: string) => {
          await client.exec(sql);
        },
        query: async <R>(sql: string, params?: unknown[]) =>
          (await client.query<R>(sql, params)).rows,
        release: () => Promise.resolve(),
      });
    },
    close: () => client.close(),
  };
}
