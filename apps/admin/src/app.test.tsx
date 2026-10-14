// @vitest-environment jsdom
import type { ApiErrorBody, SessionView } from '@lulu/api/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app.tsx';
import { installSessionHandling } from './lib/session.ts';

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const session = (
  over: Partial<SessionView['user']> = {},
  mode: 'production' | 'dev-panel' = 'production',
): SessionView => ({
  user: { id: 1, username: 'owner', role: 'owner', ...over },
  csrfToken: 'csrf-123',
  idleTimeoutSeconds: 1800,
  expiresAt: '2026-10-13T02:00:00Z',
  app: { mode },
});
const failure = (
  status: number,
  code: string,
  message: string,
): { status: number; body: ApiErrorBody } => ({
  status,
  body: { error: { code: code as ApiErrorBody['error']['code'], message, requestId: 'req-1' } },
});

let routes: Record<string, Handler>;
let calls: { path: string; init: RequestInit }[];

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/auth/session': () => failure(401, 'unauthenticated', 'لطفاً دوباره وارد شوید.'),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      const handler = routes[`${init.method ?? 'GET'} ${path}`];
      const { status, body } = handler ? handler(init) : { status: 404, body: undefined };
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  installSessionHandling(client);
  return render(
    <QueryClientProvider client={client}>
      <App memoryPath={path} />
    </QueryClientProvider>,
  );
}

async function logIn(username: string, password: string) {
  fireEvent.change(await screen.findByLabelText('نام کاربری'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('رمز'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'ورود' }));
}

describe('login page', () => {
  it('shows the server’s Persian message and clears the password on failure', async () => {
    routes['POST /api/auth/login'] = () =>
      failure(401, 'invalid_credentials', 'نام کاربری یا رمز درست نیست.');
    renderApp();
    await logIn('owner', 'wrong');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'نام کاربری یا رمز درست نیست.',
    );
    expect(screen.getByLabelText('رمز')).toHaveProperty('value', '');
  });

  it('shows the wait from the attempt limit', async () => {
    routes['POST /api/auth/login'] = () =>
      failure(
        429,
        'too_many_attempts',
        'تلاش‌های ناموفق زیاد بود. ۳۰ ثانیه دیگر دوباره امتحان کنید.',
      );
    renderApp();
    await logIn('owner', 'wrong');
    expect((await screen.findByRole('alert')).textContent).toContain('۳۰ ثانیه');
  });

  it('says so when the server cannot be reached', async () => {
    renderApp();
    await screen.findByLabelText('نام کاربری');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await logIn('owner', 'x');
    expect((await screen.findByRole('alert')).textContent).toContain('اتصال به سرور برقرار نشد');
  });
});

describe('panel frame', () => {
  it('opens on the requested page after login, with the role’s pages only', async () => {
    routes['POST /api/auth/login'] = () => ({
      status: 200,
      body: session({ role: 'admin', username: 'helper' }),
    });
    renderApp('/players');
    await logIn('helper', 'correct horse battery');

    expect(await screen.findByRole('heading', { name: 'بازیکن‌ها' })).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'بخش‌های پنل' })[0]!;
    expect(within(nav).getByRole('link', { name: 'تنظیمات اقتصاد' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'مدیران' })).toBeNull();
    expect(screen.getByText(/· مدیر/)).toBeTruthy();
  });

  it('shows owner-only pages to the owner, and the development banner in dev:panel', async () => {
    routes['GET /api/auth/session'] = () => ({ status: 200, body: session({}, 'dev-panel') });
    routes['GET /api/admins'] = () => ({ status: 200, body: [] });
    renderApp('/admins');
    expect(await screen.findByRole('heading', { name: 'مدیران' })).toBeTruthy();
    expect(screen.getByText(/حالت توسعه/)).toBeTruthy();
  });

  it('opens and closes the phone drawer', async () => {
    routes['GET /api/auth/session'] = () => ({ status: 200, body: session() });
    renderApp();
    const open = await screen.findByRole('button', { name: 'باز کردن منو' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(screen.getByRole('complementary', { name: 'منو' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'منو' })).toBeNull());
  });

  it('logs out with the CSRF token and returns to the login page', async () => {
    routes['GET /api/auth/session'] = () => ({ status: 200, body: session() });
    routes['POST /api/auth/logout'] = () => ({ status: 204 });
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'خروج' }));
    expect(await screen.findByText('از پنل خارج شدید.')).toBeTruthy();
    const logout = calls.find((c) => c.path === '/api/auth/logout')!;
    expect((logout.init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    expect(logout.init.credentials).toBe('same-origin');
  });

  it('shows untrusted names as text, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    routes['GET /api/auth/session'] = () => ({ status: 200, body: session({ username: hostile }) });
    const { container } = renderApp();
    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
