import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminLoginAttempts, adminUsers, auditLogs } from '@lulu/database';
import { usingRealPostgres } from '@lulu/database/testing';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame } from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG, parseGameConfig } from '@lulu/config';
import { configVersions } from '@lulu/database';
import { lockoutMs, loginPolicy } from './auth/login.ts';
import type { ApiErrorBody, SessionView } from './contract.ts';
import { CONTENT_SECURITY_POLICY } from './security.ts';
import type { TestApi } from './testing.ts';
import { TEST_ORIGIN, addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;

// The code defaults (suggested values in docs/assumptions.md): 5 failures / 15 min,
// sessions of 12 h with a 30-minute idle timeout.
const POLICY = loginPolicy(DEFAULT_GAME_CONFIG);
const SESSION_IDLE_MS = DEFAULT_GAME_CONFIG.admin.sessionIdleMinutes * 60_000;
const SESSION_MAX_MS = DEFAULT_GAME_CONFIG.admin.sessionTtlHours * 3_600_000;

beforeEach(async () => {
  game = await createTestGame();
  api = await createTestApi(game);
  await addAdmin(game, 'owner', 'owner');
  await addAdmin(game, 'helper', 'admin');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const errorOf = (res: { json: <T>() => T }) => res.json<ApiErrorBody>().error;

function login(username: string, password: string, headers: Record<string, string> = {}) {
  return api.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN, ...headers },
    payload: { username, password },
  });
}

describe('every response', () => {
  it('carries strict security headers and a request id', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    // HSTS only when served over HTTPS.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('answers unknown API paths with a Persian JSON 404', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({ code: 'not_found', message: 'پیدا نشد.' });
  });
});

describe('route access', () => {
  it('is declared by every API route, or the app does not start', async () => {
    expect(api.routes.length).toBeGreaterThan(0);
    for (const route of api.routes) expect(['public', 'admin', 'owner']).toContain(route.access);

    const bad = await createTestApi(game);
    expect(() => bad.app.get('/api/undeclared', () => Promise.resolve({}))).toThrow(/access/);
    await bad.app.close();
  });

  // Two real (scrypt) logins per route: slow by design, and it grows with every route.
  it('is enforced on the server for every route: anonymous, admin and owner', async () => {
    // A probe route for each level, so the matrix also covers owner-only routes.
    const probe = await createTestApi(game);
    probe.app.get('/api/probe/owner', { config: { access: 'owner' } }, () =>
      Promise.resolve({ ok: 1 }),
    );
    probe.app.post('/api/probe/owner', { config: { access: 'owner' } }, () =>
      Promise.resolve({ ok: 1 }),
    );
    await probe.app.ready();

    for (const route of probe.routes) {
      // Fresh sessions per route: calling logout must not affect the next route.
      const owner = await loginAs(probe, 'owner');
      const helper = await loginAs(probe, 'helper');
      const url = route.url.replace(/:[a-zA-Z]+/g, '1');
      const write = route.method !== 'GET';
      const call = (who?: Awaited<ReturnType<typeof loginAs>>) =>
        probe.app.inject({
          method: route.method as 'GET',
          url,
          headers: who
            ? write
              ? who.writeHeaders
              : { cookie: who.cookie }
            : { origin: TEST_ORIGIN },
          ...(write ? { payload: {} } : {}),
        });
      const label = `${route.method} ${route.url}`;
      if (route.access === 'public') continue;
      expect((await call()).statusCode, `${label} anonymous`).toBe(401);
      const asAdmin = await call(helper);
      if (route.access === 'owner') {
        expect(asAdmin.statusCode, `${label} admin`).toBe(403);
        expect(errorOf(asAdmin).code).toBe('forbidden');
      } else {
        expect(asAdmin.statusCode, `${label} admin`).not.toBe(403);
      }
      expect([401, 403], `${label} owner`).not.toContain((await call(owner)).statusCode);
    }
    await probe.app.close();
  }, 120_000);
});

describe('login', () => {
  it('starts a session with a strict HttpOnly cookie and a CSRF token', async () => {
    const res = await login('Owner ', 'correct horse battery');
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionView>();
    expect(body.user).toMatchObject({ username: 'owner', role: 'owner' });
    expect(body.csrfToken.length).toBeGreaterThan(20);
    expect(body.idleTimeoutSeconds).toBe(30 * 60);
    expect(body.app).toEqual({ mode: 'production' });
    const cookie = res.cookies.find((c) => c.name === 'lulu_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.maxAge).toBe(SESSION_MAX_MS / 1000);

    const session = await api.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `lulu_session=${cookie.value}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json<SessionView>().csrfToken).toBe(body.csrfToken);
  });

  it('uses a __Host- Secure cookie and HSTS when served over HTTPS', async () => {
    const secure = await createTestApi(game, { cookieSecure: true });
    const res = await secure.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: { username: 'owner', password: 'correct horse battery' },
    });
    const cookie = res.cookies.find((c) => c.name === '__Host-lulu_session')!;
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.domain).toBeUndefined();
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    await secure.app.close();
  });

  it('gives the same Persian answer for a wrong password and an unknown user', async () => {
    const wrong = await login('owner', 'not the password');
    const unknown = await login('nobody', 'not the password');
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toMatchObject({
        code: 'invalid_credentials',
        message: 'نام کاربری یا رمز درست نیست.',
      });
      expect(res.cookies).toHaveLength(0);
    }
  });

  it('refuses disabled admins and ends their open sessions', async () => {
    const helper = await loginAs(api, 'helper');
    await game.ctx.db
      .update(adminUsers)
      .set({ disabledAt: game.clock.now() })
      .where(eq(adminUsers.username, 'helper'));
    const session = await api.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: helper.cookie },
    });
    expect(session.statusCode).toBe(401);
    expect((await login('helper', 'correct horse battery')).statusCode).toBe(401);
  });

  it('rejects malformed requests in Persian without echoing them', async () => {
    const missing = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: { username: 'owner' },
    });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).code).toBe('invalid_request');

    const form = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=owner&password=x',
    });
    expect(form.statusCode).toBe(415);
    expect(errorOf(form).message).toBe('قالب درخواست پشتیبانی نمی‌شود.');

    const broken = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: '{"username":',
    });
    expect(broken.statusCode).toBe(400);
  });

  it('records the login in the audit log with the request id', async () => {
    const res = await login('owner', 'correct horse battery');
    const [entry] = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.login'));
    expect(entry).toMatchObject({ actor: 'admin', requestId: res.headers['x-request-id'] });
  });
});

describe('login attempt limit', () => {
  it('doubles the wait after the allowed failures, up to the window length', () => {
    expect(POLICY).toMatchObject({ freeFailures: 5, windowMs: 15 * 60_000 });
    expect(lockoutMs(4, POLICY)).toBe(0);
    expect(lockoutMs(5, POLICY)).toBe(30_000);
    expect(lockoutMs(6, POLICY)).toBe(60_000);
    expect(lockoutMs(8, POLICY)).toBe(240_000);
    expect(lockoutMs(50, POLICY)).toBe(15 * 60_000);
  });

  it('locks a username after 5 failures, even for the right password, then lets it in', async () => {
    for (let i = 0; i < POLICY.freeFailures; i++) {
      expect((await login('owner', `wrong ${i}`)).statusCode).toBe(401);
    }
    const locked = await login('owner', 'correct horse battery');
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('30');
    expect(errorOf(locked)).toMatchObject({ code: 'too_many_attempts', retryAfterSeconds: 30 });
    expect(errorOf(locked).message).toContain('۳۰ ثانیه');
    // A locked attempt is not recorded, so hammering does not extend the wait.
    const attempts = await game.ctx.db.select().from(adminLoginAttempts);
    expect(attempts).toHaveLength(5);

    game.clock.advanceSeconds(29);
    expect((await login('owner', 'correct horse battery')).statusCode).toBe(429);
    game.clock.advanceSeconds(1);
    expect((await login('owner', 'correct horse battery')).statusCode).toBe(200);
    // Success clears the count.
    expect((await login('owner', 'wrong again')).statusCode).toBe(401);
  });

  it('waits longer after each further failure', async () => {
    for (let i = 0; i < 5; i++) await login('owner', 'wrong');
    game.clock.advanceSeconds(30);
    expect((await login('owner', 'wrong')).statusCode).toBe(401);
    const locked = await login('owner', 'correct horse battery');
    expect(errorOf(locked).retryAfterSeconds).toBe(60);
    expect(errorOf(locked).message).toContain('۱ دقیقه');
  });

  it('also limits one IP spraying many usernames', async () => {
    for (let i = 0; i < POLICY.freeFailures; i++) {
      await login(`user${i}`, 'wrong');
    }
    expect((await login('owner', 'correct horse battery')).statusCode).toBe(429);
    const other = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN },
      remoteAddress: '203.0.113.9',
      payload: { username: 'owner', password: 'correct horse battery' },
    });
    expect(other.statusCode).toBe(200);
  });
});

describe.runIf(usingRealPostgres)('login attempt limit under concurrency (real PostgreSQL)', () => {
  it('lets no parallel guess past the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => login('owner', `parallel guess ${i}`)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
    const attempts = await game.ctx.db.select().from(adminLoginAttempts);
    expect(attempts).toHaveLength(5);
  });
});

describe('CSRF and origin', () => {
  it('refuses writes without the panel origin, logged in or not', async () => {
    expect(errorOf(await login('owner', 'x', { origin: 'https://evil.test' })).code).toBe(
      'bad_origin',
    );
    const noOrigin = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'correct horse battery' },
    });
    expect(noOrigin.statusCode).toBe(403);

    const owner = await loginAs(api, 'owner');
    const res = await api.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...owner.writeHeaders, origin: 'https://evil.test' },
    });
    expect(errorOf(res).code).toBe('bad_origin');
  });

  it('refuses writes without the session CSRF token', async () => {
    const owner = await loginAs(api, 'owner');
    const helper = await loginAs(api, 'helper');
    const logout = (headers: Record<string, string>) =>
      api.app.inject({ method: 'POST', url: '/api/auth/logout', headers });

    const none = await logout({ cookie: owner.cookie, origin: TEST_ORIGIN });
    expect(errorOf(none)).toMatchObject({ code: 'bad_csrf' });
    // Another session's token does not work either.
    const foreign = await logout({ ...owner.writeHeaders, 'x-csrf-token': helper.csrfToken });
    expect(foreign.statusCode).toBe(403);

    expect((await logout(owner.writeHeaders)).statusCode).toBe(204);
  });
});

describe('sessions', () => {
  const sessionStatus = async (cookie: string) =>
    (await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } }))
      .statusCode;

  it('end on logout, and the cookie no longer works', async () => {
    const owner = await loginAs(api, 'owner');
    const res = await api.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: owner.writeHeaders,
    });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'lulu_session')?.value).toBe('');
    expect(await sessionStatus(owner.cookie)).toBe(401);
    const [entry] = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.logout'));
    expect(entry?.requestId).toBe(res.headers['x-request-id']);
  });

  it('end after 30 idle minutes, but activity keeps them alive', async () => {
    const owner = await loginAs(api, 'owner');
    game.clock.advance(SESSION_IDLE_MS - 60_000);
    expect(await sessionStatus(owner.cookie)).toBe(200);
    game.clock.advance(SESSION_IDLE_MS - 60_000);
    expect(await sessionStatus(owner.cookie)).toBe(200);
    game.clock.advance(SESSION_IDLE_MS);
    expect(await sessionStatus(owner.cookie)).toBe(401);
  });

  it('end 12 hours after login however active', async () => {
    const owner = await loginAs(api, 'owner');
    for (let elapsed = 0; elapsed < SESSION_MAX_MS - 20 * 60_000; elapsed += 20 * 60_000) {
      game.clock.advance(20 * 60_000);
      expect(await sessionStatus(owner.cookie)).toBe(200);
    }
    game.clock.advance(20 * 60_000);
    expect(await sessionStatus(owner.cookie)).toBe(401);
  });

  it('follow the idle timeout of the configuration in force', async () => {
    const owner = await loginAs(api, 'owner');
    const config = parseGameConfig(structuredClone(DEFAULT_GAME_CONFIG));
    config.admin.sessionIdleMinutes = 5;
    await game.ctx.db.insert(configVersions).values({
      config,
      source: 'panel',
      effectiveFrom: game.clock.now(),
    });
    game.clock.advance(4 * 60_000);
    expect(await sessionStatus(owner.cookie)).toBe(200);
    game.clock.advance(6 * 60_000);
    expect(await sessionStatus(owner.cookie)).toBe(401);
  });

  it('are replaced when the same browser logs in again', async () => {
    const first = await loginAs(api, 'owner');
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: first.cookie },
      payload: { username: 'owner', password: 'correct horse battery' },
    });
    expect(await sessionStatus(first.cookie)).toBe(401);
  });

  it('ignore forged or garbage cookies', async () => {
    expect(await sessionStatus('lulu_session=forged-token-forged-token-forged')).toBe(401);
    expect(await sessionStatus('lulu_session=x')).toBe(401);
  });
});

describe('logs', () => {
  it('never contain passwords, cookies or tokens', async () => {
    const owner = await loginAs(api, 'owner');
    await login('owner', 'a-wrong-password-123');
    await api.app.inject({ method: 'POST', url: '/api/auth/logout', headers: owner.writeHeaders });
    const text = api.logs.join('\n');
    expect(api.logs.length).toBeGreaterThan(0);
    for (const secret of [
      'correct horse battery',
      'a-wrong-password-123',
      owner.cookie.split('=')[1]!,
      owner.csrfToken,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('built panel', () => {
  it('is served on the same origin with a fallback for client-side routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lulu-panel-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>پنل</title>');
    const withPanel = await createTestApi(game, { staticDir: dir });
    const page = await withPanel.app.inject({ method: 'GET', url: '/players/12' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('پنل');
    expect(page.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(page.headers['cache-control']).toBe('no-cache');
    const api404 = await withPanel.app.inject({ method: 'GET', url: '/api/players-x' });
    expect(api404.statusCode).toBe(404);
    expect(api404.headers['content-type']).toContain('application/json');
    await withPanel.app.close();
  });
});
