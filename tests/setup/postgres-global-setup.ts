import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedPostgres } from '@lulu/database/embedded';

/**
 * Vitest global setup for `npm run test:pg`. Starts a throwaway real PostgreSQL
 * (embedded binaries, no Docker) unless TEST_DATABASE_URL already points at one.
 * Runs in the main process before workers are spawned, so workers inherit the URL.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.LULU_TEST_DB !== 'postgres') return undefined;
  if (process.env.TEST_DATABASE_URL) return undefined;

  const server = await startEmbeddedPostgres({
    dataDir: mkdtempSync(join(tmpdir(), 'lulu-test-pg-')),
    persistent: false,
  });
  process.env.TEST_DATABASE_URL = server.url;
  return () => server.stop();
}
