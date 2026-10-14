/**
 * Recovery on the server when the panel's owner has lost the password:
 *
 *   npm run admin:reset-password -- <username>
 *
 * Prints a new random password once, ends every session of that account, clears its
 * failed-login counter and enables it again if it was disabled. Recorded in the audit
 * log. Anyone who can run this already controls the server and its .env.
 */
import { existsSync } from 'node:fs';
import { resetPasswordFromConsole } from '@lulu/api';
import { bootstrapDatabase } from '@lulu/bot';
import { baseEnvSchema, databaseEnvSchema, parseEnv } from '@lulu/config';
import { createLogger } from '@lulu/runtime';

if (existsSync('.env')) process.loadEnvFile('.env');
const username = process.argv[2];
if (!username) {
  process.stderr.write('استفاده: npm run admin:reset-password -- <نام کاربری>\n');
  process.exit(2);
}
const log = createLogger({ level: parseEnv(baseEnvSchema).LOG_LEVEL, format: 'pretty' });
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const handle = await bootstrapDatabase(DATABASE_URL, log, 'lulu-admin-reset');
try {
  const result = await resetPasswordFromConsole(handle.db, { username, now: new Date() });
  if (result.status === 'not_found') {
    const names = result.usernames.join('، ') || '(هیچ؛ اول npm run admin:bootstrap)';
    process.stderr.write(`❌ مدیری با این نام نیست. نام‌های موجود: ${names}\n`);
    process.exitCode = 1;
  } else {
    const lines = [
      `✅ رمز تازهٔ «${result.username}»: ${result.password}`,
      '   همین حالا جایی امن یادداشت کنید؛ دوباره نشان داده نمی‌شود.',
      '   بعد از ورود، از «حساب من» رمز دلخواه خودتان را بگذارید.',
    ];
    if (result.reenabled) lines.push('   این حساب غیرفعال بود و دوباره فعال شد.');
    process.stdout.write(`${lines.join('\n')}\n`);
  }
} finally {
  await handle.close();
}
