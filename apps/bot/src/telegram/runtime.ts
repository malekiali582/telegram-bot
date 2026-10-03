import type { Server } from 'node:http';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { Logger } from '@lulu/runtime';
import type { BotDeps } from '../core/processor.ts';
import { processEvent } from '../core/processor.ts';
import { TelegramAdapter } from './adapter.ts';
import { toIncomingEvents } from './convert.ts';
import { createWebhookServer } from './webhook.ts';

/** Only what the game needs; `chat_member` would require admin rights. */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
] as const;
export const WEBHOOK_PATH = '/telegram/webhook';

export interface TelegramBot {
  bot: Bot;
  botId: number;
  username: string;
  adapter: TelegramAdapter;
}

/** Validates the token (getMe) and builds the adapter. Throws on an invalid token. */
export async function connectTelegram(token: string): Promise<TelegramBot> {
  const bot = new Bot(token);
  await bot.init();
  return {
    bot,
    botId: bot.botInfo.id,
    username: bot.botInfo.username,
    adapter: new TelegramAdapter(bot.api, bot.botInfo.username),
  };
}

/**
 * Converts a raw update and processes each event, retrying transient failures (e.g. a
 * database hiccup) a few times. Processing is idempotent by update id, so a retry or
 * a redelivery never applies an action twice.
 */
export function makeUpdateHandler(
  deps: BotDeps,
  botId: number,
  log: Logger,
): (update: Update) => Promise<void> {
  return async (update) => {
    for (const event of toIncomingEvents(update, botId)) {
      for (let attempt = 1; ; attempt++) {
        try {
          const outcome = await processEvent(deps, event);
          log.debug('event', { type: event.type, updateId: event.updateId, outcome });
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          log.warn('event failed; retrying', { updateId: event.updateId, attempt, error: err });
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }
  };
}

/** Long polling (development). Removes any webhook first: never both at once. */
export async function startPolling(
  tg: TelegramBot,
  onUpdate: (update: Update) => Promise<void>,
  log: Logger,
): Promise<{ stop(): Promise<void> }> {
  await tg.bot.api.deleteWebhook({ drop_pending_updates: false });
  tg.bot.use(async (ctx) => {
    await onUpdate(ctx.update);
  });
  tg.bot.catch((err) => {
    // With long polling a failed update cannot be redelivered; it is logged instead.
    log.error('update failed after retries', {
      updateId: err.ctx.update.update_id,
      error: err.error,
    });
  });
  void tg.bot.start({
    allowed_updates: [...ALLOWED_UPDATES],
    onStart: () => log.info('telegram polling started', { bot: tg.username }),
  });
  return { stop: () => tg.bot.stop() };
}

/** Webhook (production): registers the HTTPS URL with the secret token and serves it. */
export async function startWebhook(
  tg: TelegramBot,
  options: {
    publicBaseUrl: string;
    secret: string;
    host: string;
    port: number;
    onUpdate: (update: Update) => Promise<void>;
    log: Logger;
  },
): Promise<Server> {
  const server = createWebhookServer({
    path: WEBHOOK_PATH,
    secret: options.secret,
    onUpdate: options.onUpdate,
    log: options.log,
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  await tg.bot.api.setWebhook(`${options.publicBaseUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`, {
    secret_token: options.secret,
    allowed_updates: [...ALLOWED_UPDATES],
    drop_pending_updates: false,
  });
  options.log.info('telegram webhook registered', { bot: tg.username });
  return server;
}
