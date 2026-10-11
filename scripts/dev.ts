/**
 * Development mode: `npm run dev`
 *
 * Runs everything on this computer without Docker:
 *   1. a real PostgreSQL (embedded binaries) whose data is kept in `.lulu-dev/`,
 *   2. migrations and the initial game configuration,
 *   3. a SAMPLE ghost batch for today (marked «نمونه»), if no batch is live,
 *   4. the bot with long polling and the worker (outbox sender + jobs), in one process.
 *
 * Every start-up step is logged and has a time limit: a step that fails or hangs stops
 * the run with a message saying which step and why, and shuts down what already started.
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
import { EmbeddedPostgresStartError, startEmbeddedPostgres } from '@lulu/database/embedded';
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
import { redactProxy, telegramNetworkHints } from './dev-network.ts';

const DEV_DIR = '.lulu-dev';
const DATABASE = 'lulu_dev';
const TIMEOUT = {
  /** First run includes initdb (~10 s). */
  postgres: 60_000,
  /** Migrations, configuration and the sample ghost batch. */
  database: 120_000,
  telegram: 30_000,
  bot: 30_000,
};

// ── start-up and shutdown plumbing ──

/** What has started so far, stopped in reverse order on exit. */
const cleanups: (() => Promise<unknown>)[] = [];
let phase = 'خواندن تنظیمات';
let running = false;
let stopping = false;

/** Resolves once the text is written: a write to a Windows console is asynchronous. */
function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

async function shutdown(exitCode: number, message?: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (message) await write(process.stderr, message);
  else await write(process.stdout, '\nدر حال خاموش کردن…\n');
  const stopAll = (async () => {
    for (const stop of cleanups.reverse()) await stop().catch(() => {});
  })();
  await Promise.race([stopAll, new Promise((r) => setTimeout(r, 15_000))]);
  process.exit(exitCode);
}

/** Stops the run with a clear error and shuts down whatever already started. */
async function fail(message: string): Promise<never> {
  await shutdown(1, `\n❌ ${message}\n\n`);
  return new Promise<never>(() => {}); // process.exit is under way
}

// Registered first, so Ctrl + C during start-up also stops PostgreSQL cleanly and says where it was.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (running) void shutdown(0);
    else void shutdown(130, `\n⏹️  راه‌اندازی در مرحلهٔ «${phase}» لغو شد.\n\n`);
  });
}

const TIMED_OUT = Symbol('timed out');
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs one start-up step with a time limit. On failure or timeout, `explain` adds the
 * likely cause and what to do; the run then stops.
 */
async function step<T>(
  name: string,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  explain: (err: unknown, timedOut: boolean) => string | Promise<string>,
): Promise<T> {
  phase = name;
  log.info(`${name}…`);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(resolve, timeoutMs, TIMED_OUT);
  });
  try {
    const result = await Promise.race([run(controller.signal), deadline]);
    if (result !== TIMED_OUT) return result;
    controller.abort();
    return await fail(
      `«${name}» در ${timeoutMs! / 1000} ثانیه تمام نشد.\n${await explain(undefined, true)}`,
    );
  } catch (err) {
    if (stopping) return new Promise<never>(() => {});
    return await fail(`«${name}» با خطا متوقف شد.\n${await explain(err, false)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── 0. settings ──

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
    await fail(
      'توکن ربات پیدا نشد یا نامعتبر است.\n' +
        '   فایل .env را در پوشهٔ اصلی پروژه بسازید (از روی .env.example) و این خط را با توکن ربات تستی‌تان پر کنید:\n' +
        '   TELEGRAM_BOT_TOKEN=123456789:AA...',
    );
  }
  if (err instanceof EnvError && err.variables.includes('TELEGRAM_PROXY')) {
    await fail(
      'مقدار TELEGRAM_PROXY در .env درست نیست.\n' +
        '   باید آدرس پراکسی HTTP فیلترشکن باشد، مثل TELEGRAM_PROXY=http://127.0.0.1:10809 (SOCKS پشتیبانی نمی‌شود).\n' +
        '   اگر لازمش ندارید، آن را خالی بگذارید.',
    );
  }
  throw err;
}
const hideToken = (text: string) => text.split(token).join('[token]');

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

const postgres = await step(
  `اجرای PostgreSQL محلی روی پورت ${dev.DEV_DB_PORT} (بار اول ~۱۰ ثانیه)`,
  undefined, // startEmbeddedPostgres applies TIMEOUT.postgres itself and stops a half-started server
  () =>
    startEmbeddedPostgres({
      dataDir: join(DEV_DIR, 'postgres'),
      port: dev.DEV_DB_PORT,
      password,
      persistent: true,
      startTimeoutMs: TIMEOUT.postgres,
    }),
  (err) => {
    const lines = err instanceof EmbeddedPostgresStartError ? err.log : [describe(err)];
    const text = lines.join('\n');
    const hints: string[] = [];
    if (err instanceof EmbeddedPostgresStartError && err.reason === 'timeout') {
      hints.push(`PostgreSQL در ${TIMEOUT.postgres / 1000} ثانیه آمادهٔ اتصال نشد و متوقف شد.`);
    }
    if (/could not bind|address already in use|permission denied/i.test(text)) {
      hints.push(
        `پورت ${dev.DEV_DB_PORT} در دسترس نیست (برنامهٔ دیگری آن را گرفته یا ویندوز رزروش کرده). ` +
          'در .env مقدار DEV_DB_PORT را عوض کنید، مثلاً DEV_DB_PORT=54339.',
      );
    }
    if (/postmaster\.pid|another server might be running/i.test(text)) {
      hints.push(
        'یک PostgreSQL دیگر هنوز روی همین پوشه روشن است. پنجره‌های دیگر «npm run dev» را ببندید؛ ' +
          'اگر نبود، در Task Manager پروسه‌های postgres.exe را ببندید.',
      );
    }
    hints.push(`داده‌های ${join(DEV_DIR, 'postgres')} دست نخورده‌اند.`);
    return [
      `   آخرین پیام‌های PostgreSQL:`,
      ...(lines.length ? lines : ['(PostgreSQL پیامی نداد)']).map((l) => `     ${l}`),
      ...hints.map((h) => `   ${h}`),
    ].join('\n');
  },
);
cleanups.push(() => postgres.stop());
log.info('PostgreSQL ready', { port: postgres.port });

// ── 2. database: migrations, configuration, sample ghost content (development only) ──
const databaseUrl = postgres.urlFor(DATABASE);
const ctx = await step(
  'آماده‌سازی دیتابیس (migrationها و تنظیمات بازی)',
  TIMEOUT.database,
  async () => {
    const admin = new pg.Client({ connectionString: postgres.url });
    await admin.connect();
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
      if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const handle = await bootstrapDatabase(databaseUrl, log, 'lulu-dev');
    cleanups.push(() => handle.close());
    const ctx = createDomainContext(handle.db);

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
    return ctx;
  },
  (err, timedOut) => {
    const cause = err instanceof Error && err.cause ? ` (${describe(err.cause)})` : '';
    return [
      timedOut
        ? '   migrationها یا خواندن تنظیمات بیش از حد طول کشید. اگر برنامهٔ دیگری به همین دیتابیس وصل است ببندیدش و دوباره اجرا کنید.'
        : `   ${describe(err)}${cause}`,
      '   تغییرات نیمه‌کارهٔ migration برگشت داده می‌شوند (هر migration در یک تراکنش است).',
    ].join('\n');
  },
);
log.info('database ready', { database: DATABASE });

// ── 3. Telegram ──
const tg = await step(
  'اتصال به تلگرام (getMe)',
  TIMEOUT.telegram,
  (signal) => connectTelegram(token, { signal, proxy: dev.TELEGRAM_PROXY }),
  async (err, timedOut) => {
    const reason = timedOut
      ? `   api.telegram.org در ${TIMEOUT.telegram / 1000} ثانیه جواب نداد.`
      : `   ${hideToken(describe(err))}`;
    if (!timedOut && /401|unauthorized|404|not found/i.test(describe(err))) {
      return `${reason}\n   توکن را دوباره از @BotFather کپی کنید و در .env بگذارید.`;
    }
    const hints = await telegramNetworkHints(dev.TELEGRAM_PROXY);
    return [reason, ...hints.map((h) => `   ${h}`), '   برای بررسی بیشتر: npm run dev:doctor'].join(
      '\n',
    );
  },
);
log.info('telegram connected', {
  bot: tg.username,
  via: dev.TELEGRAM_PROXY ? redactProxy(dev.TELEGRAM_PROXY) : 'direct',
});

// ── 4. worker + bot ──
await step(
  'روشن کردن worker و دریافت پیام‌ها',
  TIMEOUT.bot,
  async () => {
    const worker = await startWorker({
      ctx,
      adapters: { telegram: tg.adapter },
      log,
      listenUrl: databaseUrl,
      settleIntervalMs: 60_000,
      outboxIntervalMs: 1_000,
    });
    cleanups.push(() => worker.stop());
    const polling = await startPolling(
      tg,
      makeUpdateHandler(
        {
          ctx,
          botUsername: tg.username,
          memberRole: (c, u) => tg.adapter.getMemberRole(c, u),
          log,
        },
        tg.botId,
        log,
      ),
      log,
      {
        onFatal: (_err, code) => {
          void fail(
            code === 409
              ? 'برنامهٔ دیگری با همین توکن پیام‌های ربات را می‌گیرد (409 Conflict).\n' +
                  '   پنجرهٔ دیگری از «npm run dev» یا هر برنامهٔ دیگری که با این توکن اجرا شده را ببندید.'
              : 'دریافت پیام از تلگرام متوقف شد. خطای بالا را ببینید.',
          );
        },
      },
    );
    cleanups.push(() => polling.stop());
    return polling;
  },
  async (err, timedOut) =>
    [
      timedOut
        ? '   تلگرام به getWebhookInfo/deleteWebhook جواب نداد.'
        : `   ${hideToken(describe(err))}`,
      ...(await telegramNetworkHints(dev.TELEGRAM_PROXY)).map((h) => `   ${h}`),
    ].join('\n'),
);
running = true;

process.stdout.write(
  [
    '',
    `✅ ربات @${tg.username} روشن است (حالت توسعه، long polling).`,
    `   دیتابیس: PostgreSQL محلی در ${join(process.cwd(), DEV_DIR)} — پورت ${dev.DEV_DB_PORT}`,
    ...(dev.TELEGRAM_PROXY
      ? [
          `   اتصال به تلگرام از پراکسی ${redactProxy(dev.TELEGRAM_PROXY)} (TELEGRAM_PROXY در .env).`,
        ]
      : []),
    `   در تلگرام به همین ربات (@${tg.username}) /start بدهید یا آن را به یک گروه تستی اضافه کنید.`,
    tg.readsAllGroupMessages
      ? '   Group Privacy خاموش است: پیام سادهٔ «لولو» در گروه‌ها می‌رسد.'
      : '   ⚠️ تلگرام می‌گوید Group Privacy این ربات هنوز روشن است: در گروه‌هایی که ربات ادمین نیست فقط «/» و reply به ربات می‌رسد.\n' +
        '      BotFather ← /setprivacy ← همین ربات ← Disable؛ بعد ربات را از گروه حذف و دوباره اضافه کنید.',
    level === 'debug' || level === 'trace'
      ? '   لاگ debug روشن است: مسیر هر پیام از دریافت تا ارسال در ترمینال می‌آید.'
      : '   برای دیدن مسیر هر پیام از دریافت تا ارسال، در .env بگذارید: LOG_LEVEL=debug',
    '   برای خاموش کردن: Ctrl + C',
    '',
  ].join('\n'),
);
