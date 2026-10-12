import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { buildApi } from '@lulu/api';
import type { SessionView } from '@lulu/api';
import { queryRows } from '@lulu/database';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase } from '@lulu/database/testing';
import { createDomainContext, playerProfile } from '@lulu/domain';
import { createLogger } from '@lulu/runtime';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TelegramGuard } from '../scripts/panel-dev/no-telegram.ts';
import { blockTelegram, isTelegramHost } from '../scripts/panel-dev/no-telegram.ts';
import { preparePanelDatabase } from '../scripts/panel-dev/prepare.ts';
import { SAMPLE_PREFIX, SampleSeedRefused, seedSampleData } from '../scripts/panel-dev/seed.ts';

/**
 * `npm run dev:panel`: no connection to Telegram (the live bot runs elsewhere with the
 * same token), and labelled sample data made by the real game services.
 */

const NOW = new Date('2026-10-12T14:00:00Z');
const SMALL = { players: 10, groups: 4, days: 5, now: NOW };

let guard: TelegramGuard;
let t: TestDatabase;
let prepared: Awaited<ReturnType<typeof preparePanelDatabase>>;

beforeAll(async () => {
  guard = blockTelegram();
  t = await createTestDatabase();
  prepared = await preparePanelDatabase(t, { sample: SMALL, newPassword: false });
}, 240_000);
afterAll(async () => {
  guard.uninstall();
  await t.close();
});

const rows = <R>(query: ReturnType<typeof sql>) => queryRows<R>(t.db, query);

describe('Telegram block in the panel development mode', () => {
  it('recognises Telegram host names and address ranges only', () => {
    for (const host of [
      'api.telegram.org',
      'API.TELEGRAM.ORG.',
      't.me',
      '149.154.167.220',
      '91.108.56.130',
      '::ffff:149.154.167.99',
    ]) {
      expect(isTelegramHost(host), host).toBe(true);
    }
    for (const host of [
      '127.0.0.1',
      'localhost',
      'registry.npmjs.org',
      'nottelegram.org',
      '149.154.159.1',
    ]) {
      expect(isTelegramHost(host), host).toBe(false);
    }
  });

  it('stops fetch, https and raw TLS before any byte leaves the machine', async () => {
    const before = guard.blocked.length;
    await expect(fetch('https://api.telegram.org/bot123:abc/getMe')).rejects.toThrow();
    await new Promise<void>((resolve) => {
      https
        .get('https://api.telegram.org/', () => resolve())
        .on('error', (err) => {
          expect(err.message).toMatch(/blocked/);
          resolve();
        });
    });
    await new Promise<void>((resolve) => {
      tls.connect({ host: '149.154.167.220', port: 443 }).on('error', () => resolve());
    });
    expect(guard.blocked.slice(before)).toEqual([
      'api.telegram.org',
      'api.telegram.org',
      '149.154.167.220',
    ]);
  });

  it('leaves other connections alone (the local database and dev server)', async () => {
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('data', (d) => resolve(d.toString()));
      socket.on('error', reject);
    });
    expect(reply).toBe('ok');
    server.close();
  });

  it('is installed first by dev:panel, which never reads the bot token or loads bot networking', () => {
    const source = readFileSync(new URL('../scripts/dev-panel.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /loadEnvFile|telegramEnvSchema|@lulu\/bot\/telegram|grammy|@lulu\/worker/,
    );
    const firstStatement = code
      .split('\n')
      .map((l) => l.trim())
      .find(
        (l) =>
          l !== '' &&
          !l.startsWith('import ') &&
          !l.startsWith('}') &&
          !/^[\w{},\s]+ from /.test(l),
      );
    expect(firstStatement).toMatch(/^const telegram = blockTelegram\(/);
  });
});

describe('sample data', () => {
  it('is made only through the game services and every row is labelled', async () => {
    expect(prepared.seed).toMatchObject({ status: 'seeded', players: 10, groups: 4 });
    const people = await rows<{ display_name: string; is_sample: boolean }>(
      sql`SELECT display_name, is_sample FROM users`,
    );
    expect(people.length).toBe(10);
    for (const p of people) {
      expect(p.display_name.startsWith(SAMPLE_PREFIX)).toBe(true);
      expect(p.is_sample).toBe(true);
    }
    const cities = await rows<{ title: string; is_sample: boolean }>(
      sql`SELECT title, is_sample FROM groups`,
    );
    for (const g of cities) {
      expect(g.title.startsWith(SAMPLE_PREFIX)).toBe(true);
      expect(g.is_sample).toBe(true);
    }
  });

  it('covers both platforms', async () => {
    const platforms = await rows<{ platform: string }>(
      sql`SELECT DISTINCT platform FROM user_identities
          UNION SELECT DISTINCT platform FROM group_identities ORDER BY 1`,
    );
    expect(platforms.map((p) => p.platform)).toEqual(['rubika', 'telegram']);
  });

  it('has real, balanced ledger history over the whole period', async () => {
    const [stats] = await rows<{ days: number; kinds: string[]; total: string }>(
      sql`SELECT count(DISTINCT (t.effective_at AT TIME ZONE 'Asia/Tehran')::date)::int AS days,
                 array_agg(DISTINCT t.kind ORDER BY t.kind) AS kinds,
                 (SELECT sum(amount)::text FROM ledger_entries) AS total
          FROM transactions t`,
    );
    expect(stats!.days).toBeGreaterThanOrEqual(SMALL.days - 1);
    expect(stats!.kinds).toEqual(
      expect.arrayContaining(['lolo_reward', 'level_upgrade', 'interest']),
    );
    expect(stats!.total).toBe('0');
    const profile = await playerProfile(
      createDomainContext(t.db, { clock: { now: () => NOW } }),
      (await rows<{ id: number }>(sql`SELECT id FROM users ORDER BY id LIMIT 1`))[0]!.id,
    );
    expect(profile).toBeDefined();
  });

  it('includes the cases the panel must show: ban, removed bot, chat migration, ghosts, failures', async () => {
    const [cases] = await rows<Record<string, number>>(
      sql`SELECT (SELECT count(*)::int FROM users WHERE banned_at IS NOT NULL) AS banned,
                 (SELECT count(*)::int FROM groups WHERE bot_status = 'removed') AS removed,
                 (SELECT count(*)::int FROM group_identity_history) AS migrated,
                 (SELECT count(DISTINCT status)::int FROM ghost_batches WHERE is_sample) AS batch_states,
                 (SELECT count(*)::int FROM outbox WHERE status = 'dead') AS dead_messages,
                 (SELECT count(*)::int FROM job_runs WHERE status = 'failed') AS failed_runs`,
    );
    expect(cases).toEqual({
      banned: 1,
      removed: 1,
      migrated: 1,
      batch_states: 3,
      dead_messages: 1,
      failed_runs: 1,
    });
    const [ban] = await rows<{ ban_reason: string }>(
      sql`SELECT ban_reason FROM users WHERE banned_at IS NOT NULL`,
    );
    expect(ban!.ban_reason.startsWith(SAMPLE_PREFIX)).toBe(true);
  });

  it('reports a run that stopped part-way instead of treating it as complete', async () => {
    const other = await createTestDatabase();
    try {
      await other.db.execute(
        sql`INSERT INTO users (display_name, is_sample) VALUES ('[نمونه] نیمه', true)`,
      );
      await expect(seedSampleData(other.db, SMALL)).rejects.toThrow(/incomplete/);
    } finally {
      await other.close();
    }
  });

  it('is loaded once, never on real data and never in production', async () => {
    expect(await seedSampleData(t.db, SMALL)).toEqual({ status: 'already_seeded' });

    const other = await createTestDatabase();
    try {
      await other.db.execute(sql`INSERT INTO users (display_name) VALUES ('بازیکن واقعی')`);
      await expect(seedSampleData(other.db, SMALL)).rejects.toThrow(SampleSeedRefused);
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(seedSampleData(other.db, SMALL)).rejects.toThrow(/production/);
      } finally {
        process.env.NODE_ENV = env;
      }
    } finally {
      await other.close();
    }
  });
});

describe('dev owner account and the API in dev:panel mode', () => {
  it('logs in with the printed password and reports the mode, without touching Telegram', async () => {
    expect(prepared.owner.username).toBe('owner');
    expect(prepared.owner.password).toMatch(/^[\w-]{16}$/);
    const blockedBefore = guard.blocked.length;

    const { app } = await buildApi({
      ctx: createDomainContext(t.db),
      log: createLogger({ write: () => {} }),
      adminOrigin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      sessionSecret: 'dev-panel-secret-0123456789abcdef',
      cookieSecure: false,
      app: { mode: 'dev-panel' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:5173' },
      payload: { username: 'owner', password: prepared.owner.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionView>().app).toEqual({ mode: 'dev-panel' });
    await app.close();

    // A restart keeps the password; --new-password makes a new one.
    const again = await preparePanelDatabase(t, { sample: SMALL, newPassword: false });
    expect(again.owner.password).toBeNull();
    const reset = await preparePanelDatabase(t, { sample: SMALL, newPassword: true });
    expect(reset.owner.password).not.toBe(prepared.owner.password);

    expect(guard.blocked.length).toBe(blockedBefore);
  });
});
