/**
 * Development mode: `npm run dev`
 *
 * Runs everything on this computer without Docker:
 *   1. a real PostgreSQL (embedded binaries) whose data is kept in `.lulu-dev/`,
 *   2. migrations and the initial game configuration,
 *   3. a SAMPLE ghost batch for today (marked «نمونه»), if no batch is live,
 *   4. the bot with long polling and the worker (outbox sender + jobs), in one process.
 *
 * Needs only TELEGRAM_BOT_TOKEN in `.env` (a test bot from @BotFather).
 * Never use this for production: see docs/operations.md.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDatabase } from '@lulu/bot';
import { connectTelegram, makeUpdateHandler, startPolling } from '@lulu/bot/telegram';
import { EnvError, baseEnvSchema, devEnvSchema, parseEnv, telegramEnvSchema } from '@lulu/config';
import { startEmbeddedPostgres } from '@lulu/database/embedded';
import {
  activateDueBatches,
  createDomainContext,
  ghostContentStatus,
  importGhostBatch,
  tehranDate,
} from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import { startWorker } from '@lulu/worker';
import pg from 'pg';

const DEV_DIR = '.lulu-dev';
const DATABASE = 'lulu_dev';

function fail(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'development';
process.env.TELEGRAM_MODE = 'polling';

let token: string;
let dev: ReturnType<typeof parseEnv<typeof devEnvSchema>>;
let level: ReturnType<typeof parseEnv<typeof baseEnvSchema>>['LOG_LEVEL'];
try {
  token = parseEnv(telegramEnvSchema).TELEGRAM_BOT_TOKEN;
  dev = parseEnv(devEnvSchema);
  level = parseEnv(baseEnvSchema).LOG_LEVEL;
} catch (err) {
  if (err instanceof EnvError && err.variables.includes('TELEGRAM_BOT_TOKEN')) {
    fail(
      'توکن ربات پیدا نشد یا نامعتبر است.\n' +
        '   فایل .env را در پوشهٔ اصلی پروژه بسازید (از روی .env.example) و این خط را با توکن ربات تستی‌تان پر کنید:\n' +
        '   TELEGRAM_BOT_TOKEN=123456789:AA...',
    );
  }
  throw err;
}

const log = createLogger({ level, format: dev.LOG_FORMAT, bindings: {} });

// ── 1. PostgreSQL (persistent, local only) ──
mkdirSync(DEV_DIR, { recursive: true });
const credentialsFile = join(DEV_DIR, 'credentials.json');
if (!existsSync(credentialsFile)) {
  writeFileSync(
    credentialsFile,
    JSON.stringify({ password: randomBytes(18).toString('base64url') }),
  );
}
const { password } = JSON.parse(readFileSync(credentialsFile, 'utf8')) as { password: string };

log.info('starting local PostgreSQL (first run takes ~10 s)…');
const postgres = await startEmbeddedPostgres({
  dataDir: join(DEV_DIR, 'postgres'),
  port: dev.DEV_DB_PORT,
  password,
  persistent: true,
}).catch((err: unknown) =>
  fail(
    `PostgreSQL محلی اجرا نشد: ${err instanceof Error ? err.message : String(err)}\n` +
      `   اگر پورت ${dev.DEV_DB_PORT} اشغال است، در .env مقدار DEV_DB_PORT را عوض کنید.`,
  ),
);

const admin = new pg.Client({ connectionString: postgres.url });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE}`);
await admin.end();

const databaseUrl = postgres.urlFor(DATABASE);
const handle = await bootstrapDatabase(databaseUrl, log, 'lulu-dev');
const ctx = createDomainContext(handle.db);

// ── 2. sample ghost content (development only, clearly labelled) ──
const status = await ghostContentStatus(ctx);
if (!status.active) {
  const sample = JSON.parse(readFileSync('content/ghosts/example.json', 'utf8')) as Record<
    string,
    unknown
  >;
  const today = tehranDate(ctx.clock.now());
  const result = await importGhostBatch(
    ctx,
    { ...sample, batchId: `dev-sample-${today}`, activeDate: today },
    { source: 'dev_seed', isSample: true },
  );
  await activateDueBatches(ctx);
  log.info('sample ghost batch loaded (marked «نمونه»)', { status: result.status });
}

// ── 3. Telegram ──
const tg = await connectTelegram(token).catch(async (err: unknown) => {
  // Shut the database down cleanly before exiting.
  await handle.close().catch(() => {});
  await postgres.stop().catch(() => {});
  return fail(
    `اتصال به تلگرام برقرار نشد: ${err instanceof Error ? err.message : String(err)}\n` +
      '   توکن را دوباره از @BotFather کپی کنید و اینترنت/فیلترشکن را بررسی کنید.',
  );
});

// ── 4. worker + bot ──
const worker = await startWorker({
  ctx,
  adapters: { telegram: tg.adapter },
  log,
  listenUrl: databaseUrl,
  settleIntervalMs: 60_000,
  outboxIntervalMs: 1_000,
});
const polling = await startPolling(
  tg,
  makeUpdateHandler(
    { ctx, botUsername: tg.username, memberRole: (c, u) => tg.adapter.getMemberRole(c, u), log },
    tg.botId,
    log,
  ),
  log,
);

process.stdout.write(
  [
    '',
    `✅ ربات @${tg.username} روشن است (حالت توسعه، long polling).`,
    `   دیتابیس: PostgreSQL محلی در ${join(process.cwd(), DEV_DIR)} — پورت ${dev.DEV_DB_PORT}`,
    '   در تلگرام به ربات /start بدهید یا آن را به یک گروه تستی اضافه کنید.',
    '   برای خاموش کردن: Ctrl + C',
    '',
  ].join('\n'),
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write('\nدر حال خاموش کردن…\n');
  await polling.stop().catch(() => {});
  await worker.stop().catch(() => {});
  await handle.close().catch(() => {});
  await postgres.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
