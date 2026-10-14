import { usingRealPostgres } from '@lulu/database/testing';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame } from '@lulu/domain/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeOwners } from './auth/admins.ts';
import { setAdminRole } from './auth/manage.ts';
import type {
  AccountView,
  AdminListItemView,
  ApiErrorBody,
  AuditFiltersView,
  AuditListView,
} from './contract.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let owner: LoggedIn;
let helper: LoggedIn;
let ownerId: number;
let helperId: number;
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a much longer passphrase';

beforeEach(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  api = await createTestApi(game);
  ownerId = await addAdmin(game, 'owner', 'owner');
  helperId = await addAdmin(game, 'helper', 'admin');
  owner = await loginAs(api, 'owner');
  helper = await loginAs(api, 'helper');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const get = async <T>(url: string, who = owner) => {
  const r = await api.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
  return { status: r.statusCode, body: r.json<T>() };
};
const post = async <T>(url: string, payload: object = {}, who = owner) => {
  const r = await api.app.inject({ method: 'POST', url, headers: who.writeHeaders, payload });
  return { status: r.statusCode, body: r.json<T>() };
};
const message = (r: { body: unknown }) => (r.body as ApiErrorBody).error.message;

describe('managing admins', () => {
  it('is for the owner only, and every change needs the owner’s password again', async () => {
    expect((await get('/api/admins', helper)).status).toBe(403);
    const body = { username: 'Night_Watch', newPassword: NEW_PASSWORD, role: 'admin' };
    expect((await post('/api/admins', { ...body, password: PASSWORD }, helper)).status).toBe(403);
    const noPassword = await post<ApiErrorBody>('/api/admins', body);
    expect(noPassword.body.error.code).toBe('wrong_password');
    expect((await post('/api/admins', { ...body, password: 'wrong' })).status).toBe(403);

    const created = await post<{ id: number }>('/api/admins', { ...body, password: PASSWORD });
    expect(created.status).toBe(200);
    await loginAs(api, 'night_watch', NEW_PASSWORD);
    const list = (await get<AdminListItemView[]>('/api/admins')).body;
    expect(list.map((a) => [a.username, a.role, a.you, a.activeSessions])).toEqual([
      ['owner', 'owner', true, 1],
      ['helper', 'admin', false, 1],
      ['night_watch', 'admin', false, 1],
    ]);
    expect(list[2]!.lastLoginAt).not.toBeNull();
  });

  it('explains refused accounts in Persian', async () => {
    const create = (over: object) =>
      post('/api/admins', {
        username: 'second',
        newPassword: NEW_PASSWORD,
        role: 'admin',
        password: PASSWORD,
        ...over,
      });
    expect(message(await create({ username: 'نام' }))).toContain('حروف کوچک انگلیسی');
    expect(message(await create({ newPassword: 'short' }))).toBe('رمز باید دست‌کم ۱۲ نویسه باشد.');
    const taken = await create({ username: 'Helper' });
    expect(taken.status).toBe(409);
    expect(message(taken)).toBe('این نام کاربری از قبل هست.');
  });

  it('never demotes or removes the last active owner, and nobody removes themselves', async () => {
    const demoteSelf = await post(`/api/admins/${ownerId}/role`, {
      role: 'admin',
      password: PASSWORD,
    });
    expect(demoteSelf.status).toBe(409);
    expect(message(demoteSelf)).toContain('آخرین مالک فعال');
    const removeSelf = await post(`/api/admins/${ownerId}/disable`, {
      disabled: true,
      reason: '',
      password: PASSWORD,
    });
    expect(message(removeSelf)).toBe('حساب خودتان را نمی‌توانید حذف کنید.');

    // With a second owner, the first can step down.
    expect(
      (await post(`/api/admins/${helperId}/role`, { role: 'owner', password: PASSWORD })).status,
    ).toBe(200);
    expect(
      (await post(`/api/admins/${ownerId}/role`, { role: 'admin', password: PASSWORD })).status,
    ).toBe(200);
    expect((await get('/api/admins')).status).toBe(403); // no longer an owner
    const helperNow = await loginAs(api, 'helper');
    const removeLast = await post(
      `/api/admins/${helperId}/disable`,
      { disabled: true, reason: '', password: PASSWORD },
      helperNow,
    );
    expect(message(removeLast)).toBe('حساب خودتان را نمی‌توانید حذف کنید.');
    expect((await activeOwners(game.ctx.db)).map((o) => o.username)).toEqual(['helper']);
  });

  it('removes an admin by disabling the account and ending its sessions, and can restore it', async () => {
    const remove = await post(`/api/admins/${helperId}/disable`, {
      disabled: true,
      reason: 'دیگر همکاری نمی‌کند',
      password: PASSWORD,
    });
    expect(remove.status).toBe(200);
    expect((await get('/api/dashboard', helper)).status).toBe(401);
    await expect(loginAs(api, 'helper')).rejects.toThrow(/401/);
    const list = (await get<AdminListItemView[]>('/api/admins')).body;
    expect(list.find((a) => a.username === 'helper')?.disabledAt).not.toBeNull();

    expect(
      (
        await post(`/api/admins/${helperId}/disable`, {
          disabled: false,
          reason: '',
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
    await loginAs(api, 'helper');
  });

  it('sets a new password for another admin and signs them out everywhere', async () => {
    const reset = await post(`/api/admins/${helperId}/password`, {
      newPassword: NEW_PASSWORD,
      password: PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect((await get('/api/dashboard', helper)).status).toBe(401);
    await loginAs(api, 'helper', NEW_PASSWORD);
    const self = await post(`/api/admins/${ownerId}/password`, {
      newPassword: NEW_PASSWORD,
      password: PASSWORD,
    });
    expect(message(self)).toBe('رمز خودتان را از «حساب من» عوض کنید.');
  });
});

describe('my account', () => {
  it('lists my live sessions and signs out one of them or all the others', async () => {
    const phone = await loginAs(api, 'helper');
    const laptop = await loginAs(api, 'helper');
    const account = (await get<AccountView>('/api/account', helper)).body;
    expect(account.user).toMatchObject({ username: 'helper', role: 'admin' });
    expect(account.sessions).toHaveLength(3);
    expect(account.sessions[0]!.current).toBe(true);
    expect(account.sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);

    const current = account.sessions[0]!.id;
    expect(message(await post(`/api/account/sessions/${current}/revoke`, {}, helper))).toContain(
      '«خروج»',
    );
    const other = account.sessions[1]!.id;
    expect((await post(`/api/account/sessions/${other}/revoke`, {}, helper)).status).toBe(200);
    expect((await post(`/api/account/sessions/${other}/revoke`, {}, helper)).status).toBe(404);
    // Another admin's session id is not mine to end.
    const ownerSession = (await get<AccountView>('/api/account')).body.sessions[0]!.id;
    expect((await post(`/api/account/sessions/${ownerSession}/revoke`, {}, helper)).status).toBe(
      404,
    );

    const others = await post<{ revoked: number }>(
      '/api/account/sessions/revoke-others',
      {},
      helper,
    );
    expect(others.body.revoked).toBe(1);
    const alive = await Promise.all(
      [phone, laptop, helper].map(async (s) => (await get('/api/dashboard', s)).status),
    );
    expect(alive.filter((s) => s === 200)).toHaveLength(1);
    expect((await get('/api/dashboard', helper)).status).toBe(200);
  });

  it('changes my password with the current one and ends my other sessions', async () => {
    const other = await loginAs(api, 'helper');
    const change = (body: object) => post('/api/account/password', body, helper);
    expect((await change({ currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(
      403,
    );
    expect(message(await change({ currentPassword: PASSWORD, newPassword: 'short' }))).toBe(
      'رمز تازه باید دست‌کم ۱۲ نویسه باشد.',
    );
    expect((await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(
      200,
    );
    expect((await get('/api/dashboard', helper)).status).toBe(200);
    expect((await get('/api/dashboard', other)).status).toBe(401);
    await expect(loginAs(api, 'helper')).rejects.toThrow(/401/);
    await loginAs(api, 'helper', NEW_PASSWORD);
  });
});

describe('audit log', () => {
  it('records every admin action with the request id and filters and searches them', async () => {
    await post('/api/admins', {
      username: 'scribe',
      newPassword: NEW_PASSWORD,
      role: 'admin',
      password: PASSWORD,
    });
    await post(`/api/admins/${helperId}/disable`, {
      disabled: true,
      reason: 'مرخصی طولانی',
      password: PASSWORD,
    });

    const all = (await get<AuditListView>('/api/audit')).body; // helper is disabled now
    expect(all.items.map((e) => e.action).slice(0, 2)).toEqual(['admin.disable', 'admin.create']);
    expect(all.items[0]).toMatchObject({
      actor: 'admin',
      admin: { id: ownerId, username: 'owner' },
      targetType: 'admin_user',
      targetId: String(helperId),
      targetName: 'helper',
      reason: 'مرخصی طولانی',
    });
    expect(all.items[0]!.requestId).toMatch(/\S/);

    const byAction = await get<AuditListView>('/api/audit?action=admin.create');
    expect(byAction.body.items.map((e) => e.details)).toEqual([
      { username: 'scribe', role: 'admin' },
    ]);
    const search = await get<AuditListView>(
      `/api/audit?q=${encodeURIComponent('مرخصی')}&admin=${ownerId}`,
    );
    expect(search.body.total).toBe(1);
    const target = await get<AuditListView>(
      `/api/audit?targetType=admin_user&targetId=${helperId}&action=admin.disable`,
    );
    expect(target.body.total).toBe(1);
    expect((await get<AuditListView>('/api/audit?from=2026-10-15')).body.total).toBe(0);
    expect((await get<AuditListView>('/api/audit?to=2026-10-14')).body.total).toBe(all.total);
    expect((await get<AuditListView>('/api/audit?admin=system')).body.total).toBe(0);
    expect((await get('/api/audit?from=1405-07-22')).status).toBe(400);
    expect((await get(`/api/audit?q=${encodeURIComponent('100%_')}`)).status).toBe(200);

    const filters = (await get<AuditFiltersView>('/api/audit/filters')).body;
    expect(filters.actions).toEqual(
      expect.arrayContaining(['admin.create', 'admin.disable', 'auth.login']),
    );
    expect(filters.admins.map((a) => a.username)).toEqual(['helper', 'owner', 'scribe']);
    expect(filters.targetTypes).toContain('admin_user');
  });
});

describe.runIf(usingRealPostgres)('owners under concurrency (real PostgreSQL)', () => {
  it('two owners demoting each other at once still leave one owner', async () => {
    await setAdminRole(game.ctx.db, {
      actorId: ownerId,
      targetId: helperId,
      role: 'owner',
      now: game.clock.now(),
    });
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([
        setAdminRole(game.ctx.db, {
          actorId: helperId,
          targetId: ownerId,
          role: 'admin',
          now: game.clock.now(),
        }),
        setAdminRole(game.ctx.db, {
          actorId: ownerId,
          targetId: helperId,
          role: 'admin',
          now: game.clock.now(),
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['last_owner', 'ok']);
      expect(await activeOwners(game.ctx.db)).toHaveLength(1);
      // Promote the demoted one again for the next round.
      const [left] = await activeOwners(game.ctx.db);
      await setAdminRole(game.ctx.db, {
        actorId: left!.id,
        targetId: left!.id === ownerId ? helperId : ownerId,
        role: 'owner',
        now: game.clock.now(),
      });
    }
  });
});
