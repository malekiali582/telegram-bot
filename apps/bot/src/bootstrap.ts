import type { DatabaseHandle } from '@lulu/database';
import { connectPostgres, migrateDatabase } from '@lulu/database';
import { ensureDefaultConfig } from '@lulu/domain';
import type { Logger } from '@lulu/runtime';

/**
 * Shared start-up for every process: connect, apply pending migrations (serialized by
 * an advisory lock, so bot and worker may start together), store the initial config
 * version once, and warn if the code defaults have drifted from the stored version.
 */
export async function bootstrapDatabase(
  url: string,
  log: Logger,
  applicationName: string,
): Promise<DatabaseHandle> {
  const handle = connectPostgres(url, { applicationName });
  const { applied } = await migrateDatabase(handle);
  if (applied.length) log.info('migrations applied', { applied });
  const config = await ensureDefaultConfig(handle.db);
  if (config.created)
    log.info('initial game configuration stored', { versionId: config.versionId });
  if (!config.matchesCodeDefaults) {
    log.warn(
      'stored default configuration differs from the code defaults; the stored version stays in force',
    );
  }
  return handle;
}

/** Runs `cleanup` once on SIGINT/SIGTERM, then exits. */
export function onShutdown(cleanup: () => Promise<void>, log: Logger): void {
  let shuttingDown = false;
  const handler = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    cleanup()
      .catch((err: unknown) => log.error('shutdown failed', { error: err }))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
