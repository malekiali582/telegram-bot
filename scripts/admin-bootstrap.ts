/**
 * Creates the first owner of the admin panel:
 *
 *   npm run admin:bootstrap
 *
 * Reads DATABASE_URL, ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD. Does
 * nothing if any admin account already exists, so it can never add a second way in.
 * Remove the two ADMIN_BOOTSTRAP_* lines from .env afterwards.
 */
import { existsSync } from 'node:fs';
import { createInitialOwner } from '@lulu/api';
import { bootstrapDatabase } from '@lulu/bot';
import { adminBootstrapEnvSchema, baseEnvSchema, databaseEnvSchema, parseEnv } from '@lulu/config';
import { createLogger } from '@lulu/runtime';

if (existsSync('.env')) process.loadEnvFile('.env');
const log = createLogger({ level: parseEnv(baseEnvSchema).LOG_LEVEL, format: 'pretty' });
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const input = parseEnv(adminBootstrapEnvSchema);

const handle = await bootstrapDatabase(DATABASE_URL, log, 'lulu-admin-bootstrap');
try {
  const result = await createInitialOwner(handle.db, {
    username: input.ADMIN_BOOTSTRAP_USERNAME,
    password: input.ADMIN_BOOTSTRAP_PASSWORD,
    now: new Date(),
  });
  const messages: Record<typeof result.status, string> = {
    ok: `✅ حساب مالک «${input.ADMIN_BOOTSTRAP_USERNAME}» ساخته شد. حالا ADMIN_BOOTSTRAP_USERNAME و ADMIN_BOOTSTRAP_PASSWORD را از .env پاک کنید.`,
    admins_exist:
      'ℹ️ حساب مدیر از قبل وجود دارد؛ چیزی ساخته نشد. مدیران تازه را از پنل اضافه کنید.',
    invalid_username: '❌ ADMIN_BOOTSTRAP_USERNAME باید ۳ تا ۳۲ حرف از a-z، 0-9، _ . - باشد.',
    weak_password: '❌ ADMIN_BOOTSTRAP_PASSWORD باید دست‌کم ۱۲ نویسه باشد.',
    username_taken: '❌ این نام کاربری گرفته شده است.',
  };
  process.stdout.write(`${messages[result.status]}\n`);
  process.exitCode = result.status === 'ok' || result.status === 'admins_exist' ? 0 : 1;
} finally {
  await handle.close();
}
