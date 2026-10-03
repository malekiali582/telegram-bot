import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from '@lulu/runtime';
import type { Update } from 'grammy/types';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Constant-time comparison of the header Telegram echoes back on every webhook call. */
export function verifySecret(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal webhook endpoint (production mode). Rejects calls without the secret token,
 * and answers 200 only after the update has been processed and committed, so a
 * failure makes Telegram redeliver it (processing is idempotent by update id).
 */
export function createWebhookServer(options: {
  path: string;
  secret: string;
  onUpdate(update: Update): Promise<void>;
  log: Logger;
  maxBodyBytes?: number;
}): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== options.path) {
        res.writeHead(404).end();
        return;
      }
      if (!verifySecret(req.headers[SECRET_HEADER], options.secret)) {
        options.log.warn('webhook call with a wrong secret token');
        res.writeHead(401).end();
        return;
      }
      try {
        const update = JSON.parse(await readBody(req, options.maxBodyBytes ?? 1_000_000)) as Update;
        await options.onUpdate(update);
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      } catch (err) {
        options.log.error('webhook update failed', { error: err });
        res.writeHead(500).end();
      }
    })();
  });
}
