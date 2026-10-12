/**
 * Logical backup from the command line (the same format as the panel's «گرفتن بکاپ»):
 *
 *   npm run backup:create
 *   npm run backup:restore -- backups/lulu-backup-20261012-153000Z.jsonl.gz
 *   npm run backup:restore -- <file> --replace     # the database already has data
 *
 * Uses DATABASE_URL, BACKUP_DIR and BACKUP_KEEP from .env. Stop the bot, worker and API
 * before restoring: the restore replaces all game data. See docs/backup.md.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BackupError, createBackup, readBackupHeader, restoreBackup } from '@lulu/api';
import { backupEnvSchema, databaseEnvSchema, parseEnv } from '@lulu/config';
import { connectPostgres } from '@lulu/database';
import { ensureDefaultConfig } from '@lulu/domain';

if (existsSync('.env')) process.loadEnvFile('.env');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { replace: { type: 'boolean', default: false } },
});
const [command, file] = positionals;
const say = (text: string) => process.stdout.write(`${text}\n`);

const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const handle = connectPostgres(DATABASE_URL, { applicationName: 'lulu-backup' });
try {
  if (command === 'create') {
    const env = parseEnv(backupEnvSchema);
    const result = await createBackup(handle.db, {
      dir: resolve(env.BACKUP_DIR),
      keep: env.BACKUP_KEEP,
      now: new Date(),
    });
    const rows = Object.values(result.rows).reduce((a, b) => a + b, 0);
    say(`✅ بکاپ ساخته شد: ${resolve(env.BACKUP_DIR, result.name)}`);
    say(`   ${rows} ردیف، ${(result.bytes / 1024).toFixed(0)} کیلوبایت، sha256 ${result.sha256}`);
  } else if (command === 'restore' && file) {
    const header = await readBackupHeader(file);
    say(`بکاپ ${header.createdAt}، نسخهٔ دیتابیس ${header.migrations.at(-1)?.version ?? '-'}`);
    const result = await restoreBackup(handle, file, { replaceExisting: values.replace === true });
    await ensureDefaultConfig(handle.db);
    const rows = Object.values(result.rows).reduce((a, b) => a + b, 0);
    say(`✅ بازگردانی تمام شد: ${rows} ردیف.`);
    if (result.migratedAfter.length)
      say(`   migrationهای تازه‌تر اعمال شد: ${result.migratedAfter.join('، ')}`);
    say('   همهٔ نشست‌های پنل بسته شده‌اند؛ مدیران دوباره وارد می‌شوند.');
  } else {
    say('استفاده: npm run backup:create  |  npm run backup:restore -- <file> [--replace]');
    process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof BackupError) {
    const hint = /already has data/.test(err.message)
      ? '\n   این دیتابیس داده دارد. اگر مطمئنید باید همه‌اش جایگزین شود، --replace را اضافه کنید.'
      : '';
    process.stderr.write(`❌ ${err.message}${hint}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await handle.close();
}
