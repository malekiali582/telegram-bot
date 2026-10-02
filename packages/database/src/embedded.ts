import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * A real PostgreSQL server (official binaries via the `embedded-postgres` package),
 * started without Docker. Development and testing only.
 */
export interface EmbeddedPostgresOptions {
  dataDir: string;
  /** Free port is picked when omitted. */
  port?: number;
  user?: string;
  password?: string;
  /** Keep the data directory after `stop()` (dev mode) or delete it (tests). */
  persistent: boolean;
}

export interface RunningPostgres {
  /** Connection URL for the default `postgres` database. */
  url: string;
  port: number;
  /** URL of another database on the same server. */
  urlFor(database: string): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startEmbeddedPostgres(
  options: EmbeddedPostgresOptions,
): Promise<RunningPostgres> {
  const port = options.port ?? (await freePort());
  const user = options.user ?? 'lulu';
  const password = options.password ?? 'lulu-local-only';
  const errors: string[] = [];

  const server = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    port,
    user,
    password,
    authMethod: 'scram-sha-256',
    persistent: options.persistent,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    // Same as production: store and compare instants in UTC.
    postgresFlags: ['-c', 'timezone=UTC', '-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {},
    onError: (e) => {
      errors.push(e instanceof Error ? e.message : String(e));
    },
  });

  try {
    // A persistent dev cluster is initialised once and reused across runs.
    if (!existsSync(join(options.dataDir, 'PG_VERSION'))) await server.initialise();
    await server.start();
  } catch (err) {
    const detail = errors.slice(-5).join('\n');
    throw new Error(`embedded PostgreSQL failed to start${detail ? `:\n${detail}` : ''}`, {
      cause: err,
    });
  }

  const urlFor = (database: string) =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;

  return {
    url: urlFor('postgres'),
    port,
    urlFor,
    async stop() {
      await server.stop();
      if (!options.persistent) rmSync(options.dataDir, { recursive: true, force: true });
    },
  };
}
