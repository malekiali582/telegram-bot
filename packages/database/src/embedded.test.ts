import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddedPostgresStartError, startEmbeddedPostgres } from './embedded.ts';
import { usingRealPostgres } from './testing.ts';

// Spawns PostgreSQL binaries, so it runs with the real-PostgreSQL suite only.
describe.runIf(usingRealPostgres)('embedded PostgreSQL start-up failures', () => {
  let dataDir: string;

  beforeAll(async () => {
    // initdb once; the tests below start the same cluster again.
    dataDir = mkdtempSync(join(tmpdir(), 'lulu-embedded-test-'));
    const server = await startEmbeddedPostgres({ dataDir, persistent: true });
    await server.stop();
  }, 120_000);

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('gives up after startTimeoutMs, stops the half-started server and frees the data directory', async () => {
    const error = await startEmbeddedPostgres({ dataDir, persistent: true, startTimeoutMs: 1 })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EmbeddedPostgresStartError);
    expect((error as EmbeddedPostgresStartError).reason).toBe('timeout');

    const again = await startEmbeddedPostgres({ dataDir, persistent: true });
    const client = new pg.Client({ connectionString: again.url });
    await client.connect();
    expect((await client.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    await client.end();
    await again.stop();
  }, 60_000);

  it('reports a port in use with PostgreSQL’s own log lines instead of hanging', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const error = await startEmbeddedPostgres({ dataDir, port, persistent: true })
        .then(() => null)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(EmbeddedPostgresStartError);
      expect((error as EmbeddedPostgresStartError).reason).toBe('exited');
      expect((error as EmbeddedPostgresStartError).log.join('\n')).toMatch(/could not bind/i);
    } finally {
      blocker.close();
    }
  }, 60_000);
});
