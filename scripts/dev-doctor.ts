/**
 * Development only: read-only diagnosis of "the bot does not answer".
 *
 *   npm run dev:doctor
 *
 * Checks, without changing anything (and without calling getUpdates, so a running
 * `npm run dev` is not disturbed):
 *   1. Telegram: which bot the token belongs to, webhook, updates waiting at Telegram;
 *   2. the dev database: updates received, outbox rows (pending / sent / dead) and the
 *      sender lease.
 * The token is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { devEnvSchema, parseEnv, telegramEnvSchema } from '@lulu/config';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const say = (line = '') => process.stdout.write(`${line}\n`);
const ok = (line: string) => say(`  ✅ ${line}`);
const warn = (line: string) => say(`  ⚠️  ${line}`);
const bad = (line: string) => say(`  ❌ ${line}`);

let token = '';
try {
  token = parseEnv(telegramEnvSchema).TELEGRAM_BOT_TOKEN;
} catch {
  bad('TELEGRAM_BOT_TOKEN در .env نیست یا نامعتبر است (docs/dev-mode.md، گام ۲).');
  process.exit(1);
}
const hide = (text: string) => text.split(token).join('[token]');

/** Bot API call over IPv4, like the bot itself (see connectTelegram). */
function telegram<T>(method: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: 'api.telegram.org', path: `/bot${token}/${method}`, family: 4, timeout: 15_000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(text) as { ok: boolean; result?: T; description?: string };
            if (body.ok) resolve(body.result as T);
            else reject(new Error(`${res.statusCode} ${body.description ?? ''}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return hide(code ? `${err.message} (${code})` : err.message);
  }
  return hide(String(err));
}

// ── 1. Telegram ──
say('\n۱) تلگرام');
try {
  const me = await telegram<{ username: string; can_read_all_group_messages?: boolean }>('getMe');
  ok(`توکن معتبر است و مال ربات @${me.username} است. مطمئن شوید به همین ربات پیام می‌دهید.`);
  if (me.can_read_all_group_messages) {
    ok('Group Privacy خاموش است: تلگرام پیام سادهٔ «لولو» را در گروه‌ها به ربات می‌دهد.');
  } else {
    bad(
      `Group Privacy برای @${me.username} هنوز روشن است (طبق getMe). در گروه‌هایی که ربات ادمین نیست، فقط دستورهای «/» و reply به پیام‌های ربات می‌رسد.\n` +
        '     در BotFather: /setprivacy ← همین ربات ← Disable. بعد ربات را از گروه حذف و دوباره اضافه کنید (یا ادمینش کنید).',
    );
  }
  const info = await telegram<{
    url: string;
    pending_update_count: number;
    last_error_date?: number;
    last_error_message?: string;
  }>('getWebhookInfo');
  if (info.url) {
    warn('روی ربات webhook تنظیم شده است. «npm run dev» هنگام شروع آن را برمی‌دارد.');
    if (info.last_error_message) warn(`آخرین خطای webhook: ${info.last_error_message}`);
  } else {
    ok('webhook تنظیم نشده است (برای long polling درست است).');
  }
  const pendingAtTelegram = info.pending_update_count;
  if (pendingAtTelegram > 0) {
    warn(
      `${pendingAtTelegram} پیام در تلگرام منتظر تحویل است. اگر «npm run dev» روشن است، ` +
        'ربات پیام‌ها را نمی‌گیرد: در ترمینال دنبال «getUpdates failed» بگردید (اتصال/فیلترشکن).',
    );
  } else {
    ok('هیچ پیامی در تلگرام منتظر نمانده است (یا ربات همه را گرفته، یا پیامی نیامده).');
  }
} catch (err) {
  bad(`تلگرام در دسترس نیست یا توکن را رد کرد: ${describe(err)}`);
  say('     فیلترشکن باید روی کل سیستم (System/TUN) باشد؛ پراکسی مرورگر روی Node اثری ندارد.');
}

// ── 2. dev database ──
say('\n۲) دیتابیس توسعه');
const credentials = join('.lulu-dev', 'credentials.json');
if (!existsSync(credentials)) {
  warn('دیتابیس توسعه هنوز ساخته نشده است؛ یک بار «npm run dev» را اجرا کنید.');
  process.exit(0);
}
const { password } = JSON.parse(readFileSync(credentials, 'utf8')) as { password: string };
const { DEV_DB_PORT } = parseEnv(devEnvSchema);
const client = new pg.Client({
  connectionString: `postgres://lulu:${encodeURIComponent(password)}@127.0.0.1:${DEV_DB_PORT}/lulu_dev`,
  application_name: 'lulu-dev-doctor',
});
try {
  await client.connect();
} catch {
  warn('دیتابیس توسعه روشن نیست. این بخش فقط وقتی «npm run dev» در حال اجراست کار می‌کند.');
  process.exit(0);
}

try {
  const updates = await client.query<{ n: number; last: Date | null }>(
    'SELECT count(*)::int AS n, max(processed_at) AS last FROM processed_updates',
  );
  const u = updates.rows[0]!;
  if (u.n === 0) {
    bad(
      'هیچ پیامی به منطق بازی نرسیده است. پیام‌های غیردستوری (مثل «سلام») ثبت نمی‌شوند؛ ' +
        'برای دیدن دلیل، LOG_LEVEL=debug بگذارید و «npm run dev» را دوباره اجرا کنید.',
    );
  } else {
    ok(`${u.n} پیام پردازش شده؛ آخرین: ${u.last?.toLocaleString('fa-IR')}`);
  }

  const outbox = await client.query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM outbox GROUP BY status ORDER BY status',
  );
  const counts = Object.fromEntries(outbox.rows.map((r) => [r.status, r.n]));
  say(
    `  صف ارسال: ارسال‌شده ${counts.sent ?? 0}، در انتظار ${counts.pending ?? 0}، شکست‌خورده ${counts.dead ?? 0}`,
  );

  const stuck = await client.query<{ id: number; attempts: number; last_error: string | null }>(
    `SELECT id, attempts, last_error FROM outbox
      WHERE status = 'pending' AND next_attempt_at < now() - interval '30 seconds'
      ORDER BY id LIMIT 5`,
  );
  for (const r of stuck.rows) {
    warn(
      `پیام ${r.id} مدتی است ارسال نشده (تلاش ${r.attempts}): ${hide(r.last_error ?? 'بدون خطا')}`,
    );
  }
  const dead = await client.query<{ id: number; last_error: string | null }>(
    `SELECT id, last_error FROM outbox WHERE status = 'dead' ORDER BY id DESC LIMIT 5`,
  );
  for (const r of dead.rows) bad(`پیام ${r.id} ارسال نشد: ${hide(r.last_error ?? '')}`);

  const lease = await client.query<{ lease_owner: string | null; alive: boolean }>(
    `SELECT lease_owner, coalesce(lease_expires_at > now(), false) AS alive
       FROM job_state WHERE name = 'outbox-sender'`,
  );
  const l = lease.rows[0];
  if (l?.alive) ok('فرستندهٔ پیام (worker) فعال است.');
  else warn('فرستندهٔ پیام فعال نیست؛ آیا «npm run dev» در حال اجراست؟');
} finally {
  await client.end();
}
say();
