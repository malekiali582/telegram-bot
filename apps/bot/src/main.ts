/**
 * Bot process (production). Long polling or webhook — never both — as set by
 * TELEGRAM_MODE; production requires webhook. Outgoing messages are delivered by the
 * worker process (apps/worker).
 */
import {
  baseEnvSchema,
  databaseEnvSchema,
  parseEnv,
  telegramEnvSchema,
  webhookServerEnvSchema,
} from '@lulu/config';
import { createDomainContext } from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import { bootstrapDatabase, onShutdown } from './bootstrap.ts';
import { connectTelegram, makeUpdateHandler, startPolling, startWebhook } from './telegram.ts';

const base = parseEnv(baseEnvSchema);
const log = createLogger({ level: base.LOG_LEVEL, bindings: { app: 'bot' } });
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const tgEnv = parseEnv(telegramEnvSchema);

const handle = await bootstrapDatabase(DATABASE_URL, log, 'lulu-bot');
const tg = await connectTelegram(tgEnv.TELEGRAM_BOT_TOKEN);
const ctx = createDomainContext(handle.db);
const onUpdate = makeUpdateHandler(
  {
    ctx,
    botUsername: tg.username,
    memberRole: (chatId, userId) => tg.adapter.getMemberRole(chatId, userId),
    log,
  },
  tg.botId,
  log,
);

if (tgEnv.TELEGRAM_MODE === 'webhook') {
  const server = parseEnv(webhookServerEnvSchema);
  const http = await startWebhook(tg, {
    publicBaseUrl: tgEnv.PUBLIC_BASE_URL!,
    secret: tgEnv.TELEGRAM_WEBHOOK_SECRET!,
    host: server.TELEGRAM_WEBHOOK_HOST,
    port: server.TELEGRAM_WEBHOOK_PORT,
    onUpdate,
    log,
  });
  onShutdown(async () => {
    await new Promise((resolve) => http.close(resolve));
    await handle.close();
  }, log);
} else {
  const polling = await startPolling(tg, onUpdate, log);
  onShutdown(async () => {
    await polling.stop();
    await handle.close();
  }, log);
}
