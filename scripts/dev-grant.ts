/**
 * Development only: give points to a player on the LOCAL dev database, for manual
 * testing of upgrades and purchases. Run while `npm run dev` is running:
 *
 *   npm run dev:grant -- @username 5000
 *   npm run dev:grant -- 123456789 5000      (Telegram numeric user id)
 *
 * It uses the same audited admin adjustment as the panel will (a compensating ledger
 * transaction with a reason), so balances and the ledger stay consistent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devEnvSchema, parseEnv } from '@lulu/config';
import { adminUsers, connectPostgres, userIdentities, users } from '@lulu/database';
import { adjustBalance, createDomainContext } from '@lulu/domain';
import { parseAmount } from '@lulu/i18n';
import { eq } from 'drizzle-orm';

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

if (existsSync('.env')) process.loadEnvFile('.env');
const [who, amountText] = process.argv.slice(2);
if (!who || !amountText) fail('استفاده: npm run dev:grant -- @username 5000');
const amount = parseAmount(amountText);
if (!amount.ok) fail('مبلغ نامعتبر است.');

const credentials = join('.lulu-dev', 'credentials.json');
if (!existsSync(credentials)) fail('دیتابیس توسعه پیدا نشد؛ اول «npm run dev» را اجرا کنید.');
const { password } = JSON.parse(readFileSync(credentials, 'utf8')) as { password: string };
const { DEV_DB_PORT } = parseEnv(devEnvSchema);
const handle = connectPostgres(
  `postgres://lulu:${encodeURIComponent(password)}@127.0.0.1:${DEV_DB_PORT}/lulu_dev`,
  { applicationName: 'lulu-dev-grant', max: 2 },
);

try {
  const db = handle.db;
  const [user] = who.startsWith('@')
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, who.slice(1)))
    : await db
        .select({ id: userIdentities.userId })
        .from(userIdentities)
        .where(eq(userIdentities.platformUserId, who));
  if (!user)
    fail(`بازیکن ${who} پیدا نشد. اول با همان حساب یک‌بار در ربات «لولو» یا /start بزنید.`);

  await db
    .insert(adminUsers)
    .values({ username: 'dev-console', passwordHash: 'login-disabled', role: 'owner' })
    .onConflictDoNothing();
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.username, 'dev-console'));

  const result = await adjustBalance(createDomainContext(db), {
    userId: user.id,
    wallet: 'cash',
    amountCenti: amount.centi,
    reason: 'dev grant (manual testing)',
    adminUserId: admin!.id,
  });
  if (result.status !== 'ok') fail(`انجام نشد: ${result.status}`);
  process.stdout.write(
    `✅ ${amountText} پوینت به ${who} داده شد. موجودی نقد جدید: ${Number(result.balanceCenti) / 100}\n`,
  );
} catch (err) {
  fail(
    `اتصال به دیتابیس توسعه ممکن نشد (آیا «npm run dev» در حال اجراست؟): ${err instanceof Error ? err.message : String(err)}`,
  );
} finally {
  await handle.close();
}
