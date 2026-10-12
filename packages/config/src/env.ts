import { z } from 'zod';

/**
 * Environment schemas. Each app parses only the groups it needs, so the worker does
 * not demand panel secrets and tests do not demand a bot token.
 *
 * Error messages name the offending variables but never echo their values:
 * tokens and passwords must not reach logs.
 */

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL');

export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});

export const testDatabaseEnvSchema = z.object({
  TEST_DATABASE_URL: optionalNonEmpty.pipe(postgresUrl.optional()),
});

export const telegramEnvSchema = z
  .object({
    NODE_ENV: baseEnvSchema.shape.NODE_ENV,
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'must look like a BotFather token'),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    PUBLIC_BASE_URL: optionalNonEmpty,
    TELEGRAM_WEBHOOK_SECRET: optionalNonEmpty,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.TELEGRAM_MODE !== 'webhook') {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_MODE'],
        message: 'production must use webhook',
      });
    }
    if (env.TELEGRAM_MODE === 'webhook') {
      if (!env.PUBLIC_BASE_URL || !/^https:\/\/[^\s/]+/.test(env.PUBLIC_BASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_BASE_URL'],
          message: 'webhook mode needs an https:// URL',
        });
      }
      // Telegram allows 1-256 chars of A-Z a-z 0-9 _ -; require 32+ for entropy.
      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_WEBHOOK_SECRET'],
          message: 'webhook mode needs 32-256 chars of [A-Za-z0-9_-]',
        });
      }
    }
  });

export const apiEnvSchema = z
  .object({
    NODE_ENV: baseEnvSchema.shape.NODE_ENV,
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    ADMIN_ORIGIN: z.url(),
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    COOKIE_SECURE: bool,
    /**
     * The reverse proxy in front of the API, so the login limit sees the client's IP:
     * `false` (none), `true`, a hop count, or comma-separated addresses/CIDRs such as
     * `127.0.0.1`. Never `true` when the API port is reachable directly.
     */
    API_TRUST_PROXY: z
      .string()
      .optional()
      .transform((v): boolean | number | string => {
        const value = v?.trim() ?? '';
        if (value === '' || value === 'false') return false;
        if (value === 'true') return true;
        if (/^\d+$/.test(value)) return Number(value);
        return value;
      }),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
  });

export const workerEnvSchema = z.object({
  WORKER_SETTLE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  WORKER_OUTBOX_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
});

export const adminBootstrapEnvSchema = z.object({
  ADMIN_BOOTSTRAP_USERNAME: z.string().regex(/^[a-z0-9_.-]{3,32}$/, '3-32 chars of a-z 0-9 _ . -'),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
});

/** Logical backups made from the panel or `npm run backup:create` (docs/backup.md). */
export const backupEnvSchema = z.object({
  BACKUP_DIR: z.string().min(1).default('backups'),
  /** Only the newest backups are kept in BACKUP_DIR. */
  BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(10),
});

export const contentEnvSchema = z.object({
  GHOSTS_INCOMING_PATH: z.string().min(1).default('content/ghosts/incoming.json'),
  ALLOW_DEV_SEED: bool,
});

export class EnvError extends Error {
  readonly variables: string[];

  constructor(variables: string[], details: string[]) {
    super(`Invalid environment:\n  ${details.join('\n  ')}`);
    this.name = 'EnvError';
    this.variables = variables;
  }
}

/** Parses `env` with `schema`; throws an EnvError that lists variable names and rules only. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const variables = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '(root)')))];
  const details = result.error.issues.map(
    (i) =>
      `${String(i.path[0] ?? '(root)')}: ${i.code === 'invalid_type' ? 'missing or invalid' : i.message}`,
  );
  throw new EnvError(variables, details);
}

/** Local listener for the Telegram webhook (behind an HTTPS reverse proxy). */
export const webhookServerEnvSchema = z.object({
  TELEGRAM_WEBHOOK_HOST: z.string().min(1).default('127.0.0.1'),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65_535).default(8443),
});

/** Development mode (`npm run dev`) only. */
export const devEnvSchema = z.object({
  DEV_DB_PORT: z.coerce.number().int().min(1024).max(65_535).default(54329),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  /**
   * HTTP proxy for the Bot API, e.g. a VPN app's "system proxy" port. Node ignores the
   * Windows system proxy, so without this a VPN in proxy mode does not cover the bot.
   * Development only: the production bot and worker never read this schema.
   */
  TELEGRAM_PROXY: optionalNonEmpty.pipe(
    z
      .string()
      .regex(
        /^https?:\/\/[^\s/]+\/?$/,
        'must be an http:// proxy address such as http://127.0.0.1:10809 (SOCKS is not supported)',
      )
      .optional(),
  ),
});
