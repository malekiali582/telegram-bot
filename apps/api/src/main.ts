/**
 * API process (production): the admin panel's API, and the built panel itself
 * (apps/admin/dist) on the same origin. Run it behind an HTTPS reverse proxy; see
 * docs/operations.md. The first owner account is created with `npm run admin:bootstrap`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDatabase, onShutdown } from '@lulu/bot';
import {
  apiEnvSchema,
  backupEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  parseEnv,
} from '@lulu/config';
import { createDomainContext } from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import { buildApi } from './app.ts';

const base = parseEnv(baseEnvSchema);
const log = createLogger({ level: base.LOG_LEVEL, bindings: { app: 'api' } });
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const env = parseEnv(apiEnvSchema);
const backup = parseEnv(backupEnvSchema);

const handle = await bootstrapDatabase(DATABASE_URL, log, 'lulu-api');
const { app } = await buildApi({
  ctx: createDomainContext(handle.db),
  log,
  adminOrigin: env.ADMIN_ORIGIN,
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.COOKIE_SECURE,
  trustProxy: env.API_TRUST_PROXY,
  // apps/api/dist/main.js → apps/admin/dist
  staticDir: fileURLToPath(new URL('../../admin/dist/', import.meta.url)),
  backups: { dir: resolve(backup.BACKUP_DIR), keep: backup.BACKUP_KEEP },
});
await app.listen({ host: env.API_HOST, port: env.API_PORT });
log.info('api listening', { host: env.API_HOST, port: env.API_PORT });

onShutdown(async () => {
  await app.close();
  await handle.close();
}, log);
