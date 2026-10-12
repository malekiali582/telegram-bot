import { describe, expect, it } from 'vitest';
import {
  EnvError,
  apiEnvSchema,
  devEnvSchema,
  parseEnv,
  telegramEnvSchema,
  workerEnvSchema,
} from './env.ts';

const TOKEN = '123456789:AAEhBP0av18Z_abcdefghijklmnopqrstuv';
const SECRET = 'w3bh00k_s3cret_with_enough_entropy_123';

describe('telegram env', () => {
  it('defaults to polling in development', () => {
    expect(parseEnv(telegramEnvSchema, { TELEGRAM_BOT_TOKEN: TOKEN }).TELEGRAM_MODE).toBe(
      'polling',
    );
  });

  it('requires an https URL and a strong secret in webhook mode', () => {
    expect(() =>
      parseEnv(telegramEnvSchema, {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_MODE: 'webhook',
        PUBLIC_BASE_URL: 'http://example.com',
        TELEGRAM_WEBHOOK_SECRET: 'short',
      }),
    ).toThrow(EnvError);

    const ok = parseEnv(telegramEnvSchema, {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_MODE: 'webhook',
      PUBLIC_BASE_URL: 'https://lulu.example.com',
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    });
    expect(ok.TELEGRAM_MODE).toBe('webhook');
  });

  it('forbids polling in production', () => {
    expect(() =>
      parseEnv(telegramEnvSchema, { NODE_ENV: 'production', TELEGRAM_BOT_TOKEN: TOKEN }),
    ).toThrow(/TELEGRAM_MODE/);
  });

  it('never echoes secret values in errors', () => {
    const leakedToken = '987654321:LEAKED_TOKEN_VALUE_should_not_appear';
    try {
      parseEnv(telegramEnvSchema, {
        TELEGRAM_BOT_TOKEN: leakedToken.slice(0, 15),
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: 'bad secret value!',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const message = (err as EnvError).message;
      expect(message).not.toContain('LEAKED');
      expect(message).not.toContain('bad secret value');
      expect((err as EnvError).variables).toEqual(
        expect.arrayContaining([
          'TELEGRAM_BOT_TOKEN',
          'PUBLIC_BASE_URL',
          'TELEGRAM_WEBHOOK_SECRET',
        ]),
      );
    }
  });
});

describe('api env', () => {
  const base = {
    ADMIN_ORIGIN: 'https://panel.example.com',
    SESSION_SECRET: 'x'.repeat(32),
  };

  it('parses ports and booleans', () => {
    const env = parseEnv(apiEnvSchema, { ...base, API_PORT: '8080', COOKIE_SECURE: 'true' });
    expect(env.API_PORT).toBe(8080);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('reads the trusted proxy as off, on, a hop count or addresses', () => {
    const proxy = (API_TRUST_PROXY?: string) =>
      parseEnv(apiEnvSchema, { ...base, API_TRUST_PROXY }).API_TRUST_PROXY;
    expect(proxy()).toBe(false);
    expect(proxy('false')).toBe(false);
    expect(proxy('true')).toBe(true);
    expect(proxy('1')).toBe(1);
    expect(proxy('127.0.0.1, 10.0.0.0/8')).toBe('127.0.0.1, 10.0.0.0/8');
  });

  it('rejects short session secrets and insecure cookies in production', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, SESSION_SECRET: 'short' })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => parseEnv(apiEnvSchema, { ...base, NODE_ENV: 'production' })).toThrow(
      /COOKIE_SECURE/,
    );
  });
});

describe('worker env', () => {
  it('has safe defaults', () => {
    expect(parseEnv(workerEnvSchema, {})).toEqual({
      WORKER_SETTLE_INTERVAL_MS: 60_000,
      WORKER_OUTBOX_INTERVAL_MS: 1_000,
    });
  });
});

describe('dev env', () => {
  it('leaves TELEGRAM_PROXY unset when it is missing or empty', () => {
    expect(parseEnv(devEnvSchema, {}).TELEGRAM_PROXY).toBeUndefined();
    expect(parseEnv(devEnvSchema, { TELEGRAM_PROXY: '  ' }).TELEGRAM_PROXY).toBeUndefined();
  });

  it('accepts an http(s) proxy address', () => {
    for (const proxy of [
      'http://127.0.0.1:12334',
      'http://user:pass@proxy.local:8080/',
      'https://p.example:443',
    ]) {
      expect(parseEnv(devEnvSchema, { TELEGRAM_PROXY: proxy }).TELEGRAM_PROXY).toBe(proxy);
    }
  });

  it('rejects SOCKS and malformed proxy addresses', () => {
    for (const proxy of ['socks5://127.0.0.1:10808', '127.0.0.1:12334', 'http://host/path']) {
      expect(() => parseEnv(devEnvSchema, { TELEGRAM_PROXY: proxy })).toThrow(EnvError);
    }
  });
});
