import type { ApiErrorBody, SessionView } from '@lulu/api/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './app.tsx';
import { installSessionHandling } from './lib/session.ts';

/** Panel test kit: a fake API behind `fetch`, sessions, and rendering at a URL. */

export type Reply = { status: number; body?: unknown };
export type Handler = (init: RequestInit, path: string) => Reply;

export function sessionFor(
  user: Partial<SessionView['user']> = {},
  mode: SessionView['app']['mode'] = 'production',
): SessionView {
  return {
    user: { id: 1, username: 'owner', role: 'owner', ...user },
    csrfToken: 'csrf-123',
    idleTimeoutSeconds: 1800,
    expiresAt: '2026-10-13T02:00:00Z',
    app: { mode },
  };
}

export function failure(status: number, code: string, message: string): Reply {
  return {
    status,
    body: {
      error: { code: code as ApiErrorBody['error']['code'], message, requestId: 'req-1' },
    } satisfies ApiErrorBody,
  };
}

export interface FakeApi {
  /** `"METHOD /path"` → handler; unknown routes answer 404. */
  routes: Record<string, Handler>;
  calls: { method: string; path: string; init: RequestInit }[];
}

export function installFakeApi(session: SessionView | null = sessionFor()): FakeApi {
  const fake: FakeApi = {
    routes: {
      'GET /api/auth/session': () =>
        session ? { status: 200, body: session } : failure(401, 'unauthenticated', 'وارد شوید.'),
    },
    calls: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      fake.calls.push({ method, path, init });
      const handler = fake.routes[`${method} ${path}`];
      const { status, body } = handler ? handler(init, path) : { status: 404, body: undefined };
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return fake;
}

export function renderPanel(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  installSessionHandling(client);
  return render(
    <QueryClientProvider client={client}>
      <App memoryPath={path} />
    </QueryClientProvider>,
  );
}
