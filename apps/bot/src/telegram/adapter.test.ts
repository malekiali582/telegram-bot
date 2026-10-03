import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Api } from 'grammy';
import { GrammyError, HttpError } from 'grammy';
import { silentLogger } from '@lulu/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramAdapter, classifyTelegramError } from './adapter.ts';
import { SECRET_HEADER, createWebhookServer, verifySecret } from './webhook.ts';

const apiError = (code: number, description: string, retryAfter?: number) =>
  new GrammyError(
    'call failed',
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    },
    'sendMessage',
    {},
  );

describe('Telegram error classification', () => {
  it('maps 429 to rate_limited with retry_after, 5xx/network to transient, 4xx to permanent', () => {
    expect(classifyTelegramError(apiError(429, 'Too Many Requests', 12))).toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 12,
    });
    expect(classifyTelegramError(apiError(502, 'Bad Gateway')).kind).toBe('transient');
    expect(classifyTelegramError(new HttpError('network down', new Error('ECONNRESET'))).kind).toBe(
      'transient',
    );
    expect(
      classifyTelegramError(apiError(403, 'Forbidden: bot was blocked by the user')).kind,
    ).toBe('permanent');
    expect(classifyTelegramError(apiError(400, 'Bad Request: chat not found')).kind).toBe(
      'permanent',
    );
  });
});

describe('TelegramAdapter', () => {
  const calls: { method: string; args: unknown[] }[] = [];
  let failWith: Error | undefined;
  const api = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (...args: unknown[]) => {
          calls.push({ method, args });
          if (failWith) {
            const err = failWith;
            failWith = undefined;
            return Promise.reject(err);
          }
          return Promise.resolve(
            method === 'getChatMember' ? { status: 'administrator' } : { message_id: 99 },
          );
        },
    },
  ) as unknown as Api;
  const adapter = new TelegramAdapter(api, 'LuluBot');

  it('sends HTML with a reply, inline buttons and an add-to-group link', async () => {
    const ref = await adapter.send({
      platformChatId: '-100123',
      text: '<b>سلام</b>',
      format: 'html',
      replyToMessageId: '7',
      buttons: [
        [{ kind: 'callback', label: 'تأیید', data: 'b:x' }],
        [{ kind: 'add_to_group', label: 'افزودن' }],
      ],
    });
    expect(ref).toEqual({ platformChatId: '-100123', messageId: '99' });
    expect(calls.at(-1)).toEqual({
      method: 'sendMessage',
      args: [
        -100123,
        '<b>سلام</b>',
        {
          parse_mode: 'HTML',
          reply_parameters: { message_id: 7, allow_sending_without_reply: true },
          reply_markup: {
            inline_keyboard: [
              [{ text: 'تأیید', callback_data: 'b:x' }],
              [{ text: 'افزودن', url: 'https://t.me/LuluBot?startgroup=lulu' }],
            ],
          },
          link_preview_options: { is_disabled: true },
        },
      ],
    });
  });

  it('treats "message is not modified" and "query is too old" as success', async () => {
    failWith = apiError(400, 'Bad Request: message is not modified');
    await expect(
      adapter.edit({ platformChatId: '-1', messageId: '2' }, { text: 'x', format: 'html' }),
    ).resolves.toBe(undefined);
    failWith = apiError(400, 'Bad Request: query is too old and response timeout expired');
    await expect(adapter.answerButton('cb')).resolves.toBe(undefined);
    failWith = apiError(429, 'Too Many Requests', 3);
    await expect(adapter.answerButton('cb')).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps member status to roles', async () => {
    expect(await adapter.getMemberRole('-1', '2')).toBe('admin');
  });
});

describe('webhook', () => {
  const secret = 'a'.repeat(40);
  const received: unknown[] = [];
  let port = 0;
  const server = createWebhookServer({
    path: '/telegram/webhook',
    secret,
    onUpdate: (u) => {
      received.push(u);
      return (u as { fail?: boolean }).fail
        ? Promise.reject(new Error('db down'))
        : Promise.resolve();
    },
    log: silentLogger,
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string, body: unknown, header?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: header ? { [SECRET_HEADER]: header } : {},
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  it('compares the secret in constant time and exactly', () => {
    expect(verifySecret(secret, secret)).toBe(true);
    expect(verifySecret(`${secret}x`, secret)).toBe(false);
    expect(verifySecret(undefined, secret)).toBe(false);
    expect(verifySecret(['a'], secret)).toBe(false);
  });

  it('accepts only POSTs with the right secret; 500 makes Telegram redeliver', async () => {
    expect(await post('/telegram/webhook', { update_id: 1 }, 'wrong')).toBe(401);
    expect(await post('/telegram/webhook', { update_id: 1 })).toBe(401);
    expect(await post('/elsewhere', { update_id: 1 }, secret)).toBe(404);
    expect(received).toEqual([]);
    expect(await post('/telegram/webhook', { update_id: 2 }, secret)).toBe(200);
    expect(await post('/telegram/webhook', { update_id: 3, fail: true }, secret)).toBe(500);
    expect(received).toEqual([{ update_id: 2 }, { update_id: 3, fail: true }]);
  });
});
