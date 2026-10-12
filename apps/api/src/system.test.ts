import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { auditLogs, jobRuns, jobState, outbox, serviceHeartbeats } from '@lulu/database';
import { claimLolo } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame, newGroupWithChat, newPlayer } from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  BackupCreatedView,
  BackupView,
  DashboardView,
  SystemView,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let owner: LoggedIn;
let helper: LoggedIn;
let backupDir: string;

beforeEach(async () => {
  game = await createTestGame('2026-10-12T10:00:00Z');
  backupDir = mkdtempSync(join(tmpdir(), 'lulu-api-backups-'));
  api = await createTestApi(game, { backups: { dir: backupDir, keep: 5 } });
  await addAdmin(game, 'owner', 'owner');
  await addAdmin(game, 'helper', 'admin');
  owner = await loginAs(api, 'owner');
  helper = await loginAs(api, 'helper');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const get = <T>(url: string, who: LoggedIn = helper) =>
  api.app
    .inject({ method: 'GET', url, headers: { cookie: who.cookie } })
    .then((r) => ({ status: r.statusCode, body: r.json<T>(), raw: r }));
const post = <T>(url: string, payload: unknown, who: LoggedIn = helper) =>
  api.app
    .inject({ method: 'POST', url, headers: who.writeHeaders, payload: payload as object })
    .then((r) => ({ status: r.statusCode, body: r.json<T>() }));
const minutesAgo = (m: number) => new Date(game.clock.now().getTime() - m * 60_000);

describe('dashboard', () => {
  it('reports the economy with exact money strings and the system summary', async () => {
    const p = await newPlayer(game);
    const { groupId } = await newGroupWithChat(game);
    await claimLolo(game.ctx, { userId: p, groupId });

    const { status, body } = await get<DashboardView>('/api/dashboard');
    expect(status).toBe(200);
    expect(body.today).toBe('2026-10-12');
    expect(body.players).toMatchObject({ total: 1, activeToday: 1 });
    expect(body.circulation.now.total).toBe('100');
    expect(body.circulation.daily).toHaveLength(31);
    expect(body.flows.today.produced).toEqual([{ code: 'mint:lolo', centi: '100' }]);
    expect(body.inflation.status).toBe('not_enough_data');
    expect(body.system).toEqual({
      bot: 'never',
      worker: 'never',
      jobsWithProblems: 0,
      pendingMessages: 0,
      deadMessages: 0,
      failedRuns24h: 0,
    });
  });
});

describe('system status', () => {
  it('tells running, stopped and silent processes apart', async () => {
    const at = (m: number) => minutesAgo(m);
    await game.ctx.db.insert(serviceHeartbeats).values([
      { service: 'bot', instance: 'a:1', startedAt: at(60), lastSeenAt: at(10) },
      { service: 'worker', instance: 'b:1', startedAt: at(60), lastSeenAt: at(0.2) },
      {
        service: 'worker',
        instance: 'c:1',
        startedAt: at(90),
        lastSeenAt: at(30),
        stoppedAt: at(30),
      },
    ]);
    const { body } = await get<SystemView>('/api/system');
    expect(body.summary.bot).toBe('unresponsive');
    expect(body.summary.worker).toBe('online');
    expect(body.services.map((s) => [s.instance, s.state])).toEqual([
      ['a:1', 'unresponsive'],
      ['b:1', 'online'],
      ['c:1', 'stopped'],
    ]);
  });

  it('shows job health: last runs, failures and overdue jobs', async () => {
    await game.ctx.db.insert(jobState).values([
      { name: 'settlement', nextRunAt: minutesAgo(30), lastError: 'boom', consecutiveFailures: 2 },
      { name: 'cleanup', nextRunAt: minutesAgo(-30) },
      // The outbox sender's lease lives in job_state too, but it is not a scheduled job.
      {
        name: 'outbox-sender',
        nextRunAt: minutesAgo(600),
        leaseOwner: 'w',
        leaseExpiresAt: minutesAgo(-1),
      },
    ]);
    await game.ctx.db.insert(jobRuns).values([
      {
        jobName: 'settlement',
        leaseOwner: 'w',
        startedAt: minutesAgo(40),
        finishedAt: minutesAgo(40),
        status: 'failed',
        error: 'boom',
      },
      {
        jobName: 'settlement',
        leaseOwner: 'w',
        startedAt: minutesAgo(50),
        finishedAt: minutesAgo(50),
        status: 'succeeded',
      },
    ]);
    const { body } = await get<SystemView>('/api/system');
    const settlement = body.jobs.find((j) => j.name === 'settlement')!;
    expect(settlement).toMatchObject({ overdue: true, running: false, consecutiveFailures: 2 });
    expect(settlement.recentRuns.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    expect(body.jobs.find((j) => j.name === 'cleanup')).toMatchObject({ overdue: false });
    expect(body.jobs.map((j) => j.name)).not.toContain('outbox-sender');
    expect(body.outbox.senderActive).toBe(true);
    expect(body.recentFailures).toHaveLength(1);
    expect(body.summary).toMatchObject({ jobsWithProblems: 1, failedRuns24h: 1 });
  });

  it('lists failed messages with their group, and retries one with an audit entry', async () => {
    const { groupId, chatId } = await newGroupWithChat(game, 'شهر <b>تستی</b>');
    const [dead] = await game.ctx.db
      .insert(outbox)
      .values({
        platform: 'telegram',
        kind: 'send',
        payload: { platformChatId: chatId, text: '<script>x</script>', format: 'plain' },
        status: 'dead',
        attempts: 8,
        lastError: 'Forbidden: bot was kicked',
      })
      .returning({ id: outbox.id });

    let { body } = await get<SystemView>('/api/system');
    expect(body.outbox).toMatchObject({ pending: 0, dead: 1 });
    expect(body.outbox.deadMessages[0]).toMatchObject({
      id: dead!.id,
      group: { id: groupId, title: 'شهر <b>تستی</b>' },
      text: '<script>x</script>',
      lastError: 'Forbidden: bot was kicked',
    });

    const retried = await post(`/api/system/outbox/${dead!.id}/retry`, {});
    expect(retried).toEqual({ status: 200, body: { status: 'pending' } });
    const [row] = await game.ctx.db.select().from(outbox).where(eq(outbox.id, dead!.id));
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    const [entry] = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'outbox.retry'));
    expect(entry).toMatchObject({
      targetId: String(dead!.id),
      details: { previousError: 'Forbidden: bot was kicked' },
    });

    ({ body } = await get<SystemView>('/api/system'));
    expect(body.outbox).toMatchObject({ pending: 1, dead: 0 });
    const again = await post<ApiErrorBody>(`/api/system/outbox/${dead!.id}/retry`, {});
    expect(again.status).toBe(409);
    expect((await post(`/api/system/outbox/99999/retry`, {})).status).toBe(404);
    expect((await post(`/api/system/outbox/abc/retry`, {})).status).toBe(400);
  });
});

describe('backups', () => {
  it('are made only by the owner after retyping the password, then listed and downloaded', async () => {
    expect((await post('/api/system/backups', { password: 'correct horse battery' })).status).toBe(
      403,
    );

    const wrong = await post<ApiErrorBody>('/api/system/backups', { password: 'nope' }, owner);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: 'wrong_password', message: 'رمز درست نیست.' });
    expect(readdirSync(backupDir)).toEqual([]);

    const made = await post<BackupCreatedView>(
      '/api/system/backups',
      { password: 'correct horse battery' },
      owner,
    );
    expect(made.status).toBe(200);
    expect(made.body.name).toBe('lulu-backup-20261012-100000Z.jsonl.gz');
    expect(made.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await get<{ backups: BackupView[]; keep: number }>('/api/system/backups', owner);
    expect(list.body.backups.map((b) => b.name)).toEqual([made.body.name]);
    expect(list.body.keep).toBe(5);

    const file = await api.app.inject({
      method: 'GET',
      url: `/api/system/backups/${made.body.name}`,
      headers: { cookie: owner.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${made.body.name}"`);
    expect(gunzipSync(file.rawPayload).toString('utf8')).toMatch(/^#lulu-backup\t/);

    const actions = (await game.ctx.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['backup.create', 'backup.download']));
  });

  it('count a wrong retyped password like a failed login', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/system/backups', { password: `wrong ${i}` }, owner)).status).toBe(
        403,
      );
    }
    const locked = await post<ApiErrorBody>(
      '/api/system/backups',
      { password: 'correct horse battery' },
      owner,
    );
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('too_many_attempts');
  });

  it('refuse names outside the backup folder and missing files', async () => {
    const bad = await get<ApiErrorBody>('/api/system/backups/..%2F..%2Fpackage.json', owner);
    expect(bad.status).toBe(400);
    const missing = await get<ApiErrorBody>(
      '/api/system/backups/lulu-backup-20200101-000000Z.jsonl.gz',
      owner,
    );
    expect(missing.status).toBe(404);
  });

  it('say so when no backup folder is configured', async () => {
    const bare = await createTestApi(game);
    const me = await loginAs(bare, 'owner');
    const res = await bare.app.inject({
      method: 'GET',
      url: '/api/system/backups',
      headers: { cookie: me.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorBody>().error.message).toContain('تنظیم نشده');
    await bare.app.close();
  });
});
