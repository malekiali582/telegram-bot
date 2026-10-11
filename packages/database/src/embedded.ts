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
  /** Give up (and stop the server) if it does not accept connections by then. Default 60 s. */
  startTimeoutMs?: number;
}

/**
 * The server did not come up. `log` holds its last output lines: PostgreSQL says why
 * there (port in use, another server on the same data directory, damaged files…).
 */
export class EmbeddedPostgresStartError extends Error {
  readonly reason: 'timeout' | 'exited';
  readonly log: string[];

  constructor(reason: 'timeout' | 'exited', log: string[], options?: ErrorOptions) {
    const what =
      reason === 'timeout'
        ? 'did not accept connections in time'
        : 'stopped before it accepted connections';
    super(
      `embedded PostgreSQL ${what}` +
        (log.length ? `; last log lines:\n${log.join('\n')}` : ' (no log output)'),
      options,
    );
    this.name = 'EmbeddedPostgresStartError';
    this.reason = reason;
    this.log = log;
  }
}

const LOG_LINES_KEPT = 20;

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
  const recentLog: string[] = [];
  const keep = (output: unknown) => {
    const text = output instanceof Error ? output.message : String(output);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) recentLog.push(line);
    }
    recentLog.splice(0, recentLog.length - LOG_LINES_KEPT);
  };

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
    onLog: keep,
    onError: keep,
  });

  // `start()` resolves on the "ready to accept connections" log line and rejects (without
  // a reason) only when the process exits; it never times out on its own.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, options.startTimeoutMs ?? 60_000, 'timeout');
  });
  const starting = (async () => {
    // A persistent dev cluster is initialised once and reused across runs.
    if (!existsSync(join(options.dataDir, 'PG_VERSION'))) await server.initialise();
    await server.start();
  })();
  try {
    if ((await Promise.race([starting, deadline])) === 'timeout') {
      // Still running but not ready: stop it, so it does not hold the port or the data directory.
      await Promise.race([server.stop(), new Promise((r) => setTimeout(r, 10_000))]);
      throw new EmbeddedPostgresStartError('timeout', recentLog);
    }
  } catch (err) {
    if (err instanceof EmbeddedPostgresStartError) throw err;
    if (err instanceof Error) keep(err.message); // initdb failures carry their output here
    throw new EmbeddedPostgresStartError('exited', recentLog, { cause: err });
  } finally {
    clearTimeout(timer);
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
