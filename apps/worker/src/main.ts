/**
 * Worker process (production): delivers the outbox through Telegram and runs the
 * periodic jobs (settlement, ghost batch activation, cleanup).
 */
import { bootstrapDatabase, onShutdown } from '@lulu/bot';
import { connectTelegram } from '@lulu/bot/telegram';
import {
  baseEnvSchema,
  databaseEnvSchema,
  parseEnv,
  telegramEnvSchema,
  workerEnvSchema,
} from '@lulu/config';
import { createDomainContext } from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import { startWorker } from './index.ts';

const base = parseEnv(baseEnvSchema);
const log = createLogger({ level: base.LOG_LEVEL, bindings: { app: 'worker' } });
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const { TELEGRAM_BOT_TOKEN } = parseEnv(telegramEnvSchema);
const intervals = parseEnv(workerEnvSchema);

const handle = await bootstrapDatabase(DATABASE_URL, log, 'lulu-worker');
const tg = await connectTelegram(TELEGRAM_BOT_TOKEN);
const worker = await startWorker({
  ctx: createDomainContext(handle.db),
  adapters: { telegram: tg.adapter },
  log,
  listenUrl: DATABASE_URL,
  outboxIntervalMs: intervals.WORKER_OUTBOX_INTERVAL_MS,
});
log.info('worker started');

onShutdown(async () => {
  await worker.stop();
  await handle.close();
}, log);
