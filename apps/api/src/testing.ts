import type { AdminRole } from './contract.ts';
import type { ApiOptions } from './app.ts';
import { buildApi } from './app.ts';
import { createAdminUser } from './auth/admins.ts';
import type { TestGame } from '@lulu/domain/testing';
import { createLogger } from '@lulu/runtime';
import type { FastifyInstance } from 'fastify';

/** Test kit for API tests: an app on a test game, plus login helpers. */

export const TEST_ORIGIN = 'https://panel.test';
export const TEST_SECRET = 'test-session-secret-0123456789abcdef';

export interface TestApi {
  app: FastifyInstance;
  routes: Awaited<ReturnType<typeof buildApi>>['routes'];
  /** Every log line the app wrote. */
  logs: string[];
}

export async function createTestApi(
  game: TestGame,
  overrides: Partial<ApiOptions> = {},
): Promise<TestApi> {
  const logs: string[] = [];
  const { app, routes } = await buildApi({
    ctx: game.ctx,
    log: createLogger({ level: 'trace', write: (line) => logs.push(line) }),
    adminOrigin: TEST_ORIGIN,
    sessionSecret: TEST_SECRET,
    cookieSecure: false,
    ...overrides,
  });
  return { app, routes, logs };
}

export async function addAdmin(
  game: TestGame,
  username: string,
  role: AdminRole,
  password = 'correct horse battery',
): Promise<number> {
  const result = await createAdminUser(game.ctx.db, {
    username,
    password,
    role,
    now: game.clock.now(),
  });
  if (result.status !== 'ok') throw new Error(`could not create admin: ${result.status}`);
  return result.adminUserId;
}

export interface LoggedIn {
  cookie: string;
  csrfToken: string;
  /** Headers for a write request in this session. */
  writeHeaders: Record<string, string>;
}

export async function loginAs(
  api: TestApi,
  username: string,
  password = 'correct horse battery',
): Promise<LoggedIn> {
  const res = await api.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN },
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const session = res.cookies.find((c) => c.name.endsWith('lulu_session'));
  if (!session) throw new Error('no session cookie');
  const cookie = `${session.name}=${session.value}`;
  const { csrfToken } = res.json<{ csrfToken: string }>();
  return {
    cookie,
    csrfToken,
    writeHeaders: { cookie, origin: TEST_ORIGIN, 'x-csrf-token': csrfToken },
  };
}
