import type { Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Transformer } from 'grammy';
import { Bot, GrammyError } from 'grammy';
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
  /**
   * `getMe.can_read_all_group_messages`: false while BotFather's Group Privacy is on.
   * Then, in groups where the bot is not an admin, Telegram delivers only «/» commands,
   * replies to the bot's messages and mentions, so a plain «لولو» never arrives.
   */
  readsAllGroupMessages: boolean;
}

/**
 * Connections to the Bot API use IPv4 only. api.telegram.org also resolves to IPv6,
 * and Node's address auto-selection gives IPv4 just 250 ms per new connection before
 * trying IPv6; behind a VPN or on a host without working IPv6 that ends in ETIMEDOUT
 * (measured: 2 of 12 fresh connections failed, 0 of 12 with IPv4 only). The Bot API
 * is always reachable over IPv4.
 */
const telegramAgent = new HttpsAgent({ keepAlive: true, family: 4 });

/** Validates the token (getMe) and builds the adapter. Throws on an invalid token. */
export async function connectTelegram(token: string): Promise<TelegramBot> {
  const bot = new Bot(token, { client: { baseFetchConfig: { agent: telegramAgent } } });
  await bot.init();
  return {
    bot,
    botId: bot.botInfo.id,
    username: bot.botInfo.username,
    adapter: new TelegramAdapter(bot.api, bot.botInfo.username),
    readsAllGroupMessages: bot.botInfo.can_read_all_group_messages,
  };
}

/**
 * Says at startup whether Telegram will deliver plain group messages. Group Privacy is
 * a Telegram-side setting; the bot cannot change it, only report what getMe says.
 */
export function logGroupPrivacy(tg: TelegramBot, log: Logger): void {
  if (tg.readsAllGroupMessages) {
    log.info('group privacy is off: plain group messages are delivered', { bot: tg.username });
    return;
  }
  log.warn(
    'group privacy is ON for this bot: in groups where it is not an admin, Telegram delivers only /commands and replies to its messages, so a plain «لولو» is never received',
    {
      bot: tg.username,
      fix: 'BotFather → /setprivacy → this bot → Disable, then remove the bot from each group and add it again (or make it an admin)',
    },
  );
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
    const events = toIncomingEvents(update, botId);
    const first = events[0];
    log.debug('update received', {
      updateId: update.update_id,
      kinds: Object.keys(update).filter((k) => k !== 'update_id'),
      events: events.map((e) => e.type),
      ...(first ? { chat: first.chat.kind, chatId: first.chat.platformChatId } : {}),
    });
    for (const event of events) {
      for (let attempt = 1; ; attempt++) {
        try {
          const outcome = await processEvent(deps, event);
          log.debug('event handled', { type: event.type, updateId: event.updateId, outcome });
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

/**
 * Makes long polling observable. grammY retries failed `getUpdates` calls on its own
 * and reports them only through the `debug` package (silent by default), so a broken
 * connection would otherwise look like a bot that simply receives nothing.
 */
export function pollingObserver(log: Logger): Transformer {
  let working = false;
  let failures = 0;

  const observe = async (
    poll: () => Promise<PollResponse>,
    offset: number | undefined,
    signal: { readonly aborted: boolean } | undefined,
  ): Promise<PollResponse> => {
    let response: PollResponse;
    try {
      response = await poll();
    } catch (err) {
      if (signal?.aborted) throw err; // polling stopped on purpose
      failures++;
      log.warn('telegram getUpdates failed (network); retrying', { failures, error: err });
      throw err;
    }
    if (!response.ok) {
      failures++;
      log.warn('telegram getUpdates rejected', {
        failures,
        code: response.error_code,
        description: response.description,
      });
      return response;
    }
    if (!working || failures > 0) {
      log.info(working ? 'telegram getUpdates recovered' : 'telegram getUpdates works', {
        afterFailures: failures,
      });
      working = true;
      failures = 0;
    }
    const count = Array.isArray(response.result) ? response.result.length : 0;
    if (count > 0) log.debug('telegram getUpdates', { count, offset });
    else log.trace('telegram getUpdates', { count, offset });
    return response;
  };

  return (prev, method, payload, signal) => {
    if (method !== 'getUpdates') return prev(method, payload, signal);
    const offset = (payload as { offset?: number } | undefined)?.offset;
    const poll = () => prev(method, payload, signal) as Promise<PollResponse>;
    return observe(poll, offset, signal) as ReturnType<typeof prev<typeof method>>;
  };
}

/** The parts of a Bot API response the observer looks at. */
type PollResponse =
  { ok: true; result: unknown } | { ok: false; error_code: number; description: string };

/**
 * Long polling (development). Removes any webhook first: never both at once.
 * `onFatal` is called if polling ends by itself, e.g. 409 Conflict (another process
 * polls with the same token) or 401 (token revoked).
 */
export async function startPolling(
  tg: TelegramBot,
  onUpdate: (update: Update) => Promise<void>,
  log: Logger,
  options: { onFatal?: (error: unknown, code: number | undefined) => void } = {},
): Promise<{ stop(): Promise<void> }> {
  logGroupPrivacy(tg, log);
  const info = await tg.bot.api.getWebhookInfo();
  if (info.url)
    log.warn('removing the webhook set on this bot', { pending: info.pending_update_count });
  await tg.bot.api.deleteWebhook({ drop_pending_updates: false });
  tg.bot.api.config.use(pollingObserver(log));
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
  tg.bot
    .start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: () => log.info('telegram polling started', { bot: tg.username }),
    })
    .catch((err: unknown) => {
      const code = err instanceof GrammyError ? err.error_code : undefined;
      log.error('telegram polling stopped', {
        code,
        hint:
          code === 409
            ? 'another process is receiving updates for this bot (same token)'
            : code === 401
              ? 'the bot token is no longer valid'
              : undefined,
        error: err,
      });
      options.onFatal?.(err, code);
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
  logGroupPrivacy(tg, options.log);
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
