/**
 * Admin panel development mode: `npm run dev:panel`
 *
 * Runs only the API and the panel, on this computer, without Telegram:
 *   1. every connection to Telegram from this process is blocked (the live bot runs on
 *      another computer with the same token); `.env` is not read at all, so the bot
 *      token never enters this process;
 *   2. a separate local PostgreSQL in `.lulu-panel-dev/` (port 54330); the bot's own
 *      `.lulu-dev/` is never touched;
 *   3. migrations, the game configuration and, on the first run, labelled sample data
 *      («[نمونه]», both platforms, 45 days of real ledger history);
 *   4. a local owner account whose password is printed here (first run, or with
 *      `npm run dev:panel -- --new-password`);
 *   5. the API, and the panel with hot reload on http://localhost:5173.
 *
 * No worker runs: nothing is ever sent. Ports can be changed with PANEL_DEV_DB_PORT,
 * PANEL_DEV_API_PORT and PANEL_DEV_PORT in the shell (not in .env).
 * Delete `.lulu-panel-dev/` to start again from fresh sample data.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApi } from '@lulu/api';
import type { DatabaseHandle } from '@lulu/database';
import { connectPostgres } from '@lulu/database';
import { EmbeddedPostgresStartError, startEmbeddedPostgres } from '@lulu/database/embedded';
import { createDomainContext } from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import pg from 'pg';
import { createServer as createViteServer } from 'vite';
import { blockTelegram } from './panel-dev/no-telegram.ts';
import { preparePanelDatabase } from './panel-dev/prepare.ts';
import { FULL_SAMPLE, SampleSeedRefused } from './panel-dev/seed.ts';

const telegram = blockTelegram((host) => {
  process.stderr.write(`⛔ اتصال به تلگرام (${host}) در حالت توسعهٔ پنل مسدود شد.\n`);
});
// Even a token exported in the shell is dropped before anything else runs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('TELEGRAM_')) delete process.env[key];
}

const DEV_DIR = '.lulu-panel-dev';
const DATABASE = 'lulu_panel_dev';
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    process.stderr.write(`❌ ${name} باید عددی بین 1024 و 65535 باشد.\n`);
    process.exit(1);
  }
  return value;
};
const PORTS = {
  db: port('PANEL_DEV_DB_PORT', 54330),
  api: port('PANEL_DEV_API_PORT', 3100),
  panel: port('PANEL_DEV_PORT', 5173),
};
const { values: args } = parseArgs({ options: { 'new-password': { type: 'boolean' } } });

const log = createLogger({ level: 'info', format: 'pretty', bindings: {} });
const say = (text: string) => new Promise<void>((done) => process.stdout.write(text, () => done()));

// ── shutdown ──
const cleanups: (() => Promise<unknown>)[] = [];
let stopping = false;
async function shutdown(code: number, message?: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await say(message ?? '\nدر حال خاموش کردن…\n');
  const all = (async () => {
    for (const stop of cleanups.reverse()) await stop().catch(() => {});
  })();
  await Promise.race([all, new Promise((r) => setTimeout(r, 15_000))]);
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(0));
const fail = async (message: string): Promise<never> => {
  await shutdown(1, `\n❌ ${message}\n\n`);
  return new Promise<never>(() => {});
};

// ── 1. local secrets (generated once, kept in the git-ignored folder) ──
mkdirSync(DEV_DIR, { recursive: true });
const credentialsFile = join(DEV_DIR, 'credentials.json');
if (!existsSync(credentialsFile)) {
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      databasePassword: randomBytes(18).toString('base64url'),
      sessionSecret: randomBytes(48).toString('base64url'),
    }),
  );
}
const secrets = JSON.parse(readFileSync(credentialsFile, 'utf8')) as {
  databasePassword: string;
  sessionSecret: string;
};

// ── 2. PostgreSQL ──
log.info(`اجرای PostgreSQL پنل روی پورت ${PORTS.db} (بار اول ~۱۰ ثانیه)…`);
const postgres = await startEmbeddedPostgres({
  dataDir: join(DEV_DIR, 'postgres'),
  port: PORTS.db,
  password: secrets.databasePassword,
  persistent: true,
  startTimeoutMs: 60_000,
}).catch((err: unknown) =>
  fail(
    [
      'PostgreSQL پنل روشن نشد.',
      ...(err instanceof EmbeddedPostgresStartError ? err.log : [String(err)]).map(
        (l) => `   ${l}`,
      ),
      `   اگر پورت ${PORTS.db} گرفته است: PANEL_DEV_DB_PORT=54340 npm run dev:panel`,
      '   اگر پنجرهٔ دیگری از dev:panel باز است، اول آن را ببندید.',
    ].join('\n'),
  ),
);
cleanups.push(() => postgres.stop());

const admin = new pg.Client({ connectionString: postgres.url });
await admin.connect();
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE}`);
} finally {
  await admin.end();
}
const handle: DatabaseHandle = connectPostgres(postgres.urlFor(DATABASE), {
  applicationName: 'lulu-dev-panel',
});
cleanups.push(() => handle.close());

// ── 3. schema, configuration, sample data, owner account ──
log.info('آماده‌سازی دیتابیس پنل (migration، تنظیمات، دادهٔ نمونه)…');
let lastShown = 0;
const prepared = await preparePanelDatabase(handle, {
  sample: {
    ...FULL_SAMPLE,
    now: new Date(),
    onProgress: (day, days) => {
      if (day === 1)
        log.info(`ساخت دادهٔ نمونه با سرویس‌های واقعی بازی (${days} روز)؛ فقط بار اول…`);
      const percent = Math.floor((day / days) * 100);
      if (percent >= lastShown + 20 || day === days) {
        lastShown = percent;
        log.info(`دادهٔ نمونه: ${percent}٪`);
      }
    },
  },
  newPassword: args['new-password'] === true,
}).catch((err: unknown) =>
  fail(
    err instanceof SampleSeedRefused
      ? `دادهٔ نمونه ساخته نشد: ${err.message}
   برای شروع دوباره، پنل را ببندید و پوشهٔ ${DEV_DIR} را پاک کنید.`
      : `آماده‌سازی دیتابیس پنل شکست خورد: ${String(err)}`,
  ),
);

// ── 4. API and panel ──
const panelOrigins = [`http://localhost:${PORTS.panel}`, `http://127.0.0.1:${PORTS.panel}`];
const { app } = await buildApi({
  ctx: createDomainContext(handle.db),
  log,
  adminOrigin: panelOrigins,
  sessionSecret: secrets.sessionSecret,
  cookieSecure: false, // plain HTTP on this computer only
  app: { mode: 'dev-panel' },
});
await app
  .listen({ host: '127.0.0.1', port: PORTS.api })
  .catch((err: unknown) =>
    fail(`API روی پورت ${PORTS.api} بالا نیامد (${String(err)}). PANEL_DEV_API_PORT را عوض کنید.`),
  );
cleanups.push(() => app.close());

const vite = await createViteServer({
  configFile: resolve('apps/admin/vite.config.ts'),
  root: resolve('apps/admin'),
  server: {
    host: '127.0.0.1',
    port: PORTS.panel,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${PORTS.api}`, changeOrigin: false } },
  },
  clearScreen: false,
});
await vite
  .listen()
  .catch((err: unknown) =>
    fail(`پنل روی پورت ${PORTS.panel} بالا نیامد (${String(err)}). PANEL_DEV_PORT را عوض کنید.`),
  );
cleanups.push(() => vite.close());

const seedLine =
  prepared.seed.status === 'seeded'
    ? `   دادهٔ نمونه ساخته شد: ${prepared.seed.players} بازیکن، ${prepared.seed.groups} گروه، ${prepared.seed.transactions} تراکنش (همه با برچسب «[نمونه]»).`
    : '   دادهٔ نمونه از قبل هست (برای دادهٔ تازه پوشهٔ .lulu-panel-dev را پاک کنید).';
const passwordLines = prepared.owner.password
  ? [
      `   نام کاربری: ${prepared.owner.username}`,
      `   رمز:        ${prepared.owner.password}`,
      '   (این رمز فقط همین یک بار نشان داده می‌شود؛ رمز تازه: npm run dev:panel -- --new-password)',
    ]
  : [
      `   نام کاربری: ${prepared.owner.username} (رمز در اولین اجرا چاپ شد)`,
      '   رمز را ندارید؟ npm run dev:panel -- --new-password',
    ];
await say(
  [
    '',
    `✅ پنل مدیریت (حالت توسعه) روشن است: http://localhost:${PORTS.panel}`,
    `   دیتابیس جدا: ${join(process.cwd(), DEV_DIR)} — پورت ${PORTS.db} (به .lulu-dev ربات دست نمی‌زند)`,
    seedLine,
    ...passwordLines,
    `   تلگرام: هیچ اتصالی برقرار نمی‌شود (${telegram.blocked.length} تلاش مسدود شد). worker و ارسال پیام خاموش است.`,
    '   برای خاموش کردن: Ctrl + C',
    '',
  ].join('\n'),
);
