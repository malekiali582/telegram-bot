// @vitest-environment jsdom
import type { DashboardView, SystemView } from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeApi } from '../testing.tsx';
import { failure, installFakeApi, renderPanel, sessionFor } from '../testing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const day = (date: string, total: string) => ({
  date,
  cash: total,
  treasury: '0',
  bloodBank: '0',
  total,
});

function dashboard(over: Partial<DashboardView> = {}): DashboardView {
  const flow = {
    produced: [
      { code: 'mint:lolo', centi: '150000' },
      { code: 'mint:interest', centi: '5000' },
    ],
    consumed: [{ code: 'burn:tool', centi: '50000' }],
    adjustments: '0',
    net: '105000',
  };
  return {
    today: '2026-10-12',
    players: { total: 60, banned: 1, activeToday: 12, active7d: 40, active30d: 55 },
    groups: { total: 8, withBot: 7, activeToday: 5 },
    circulation: {
      now: {
        date: '2026-10-12',
        cash: '1000000',
        treasury: '2345600',
        bloodBank: '50000',
        total: '3395600',
      },
      // 2026-09-11 … 2026-10-12
      daily: Array.from({ length: 31 }, (_, i) =>
        day(
          new Date(Date.UTC(2026, 8, 12 + i)).toISOString().slice(0, 10),
          String(100000 * (i + 1)),
        ),
      ),
    },
    flows: {
      today: flow,
      week: { ...flow, produced: [{ code: 'mint:streak', centi: '9900' }] },
      month: flow,
    },
    inflation: {
      status: 'warning',
      day: {
        from: '2026-10-10',
        to: '2026-10-11',
        base: '100',
        change: '23',
        growthBp: 2380,
        thresholdBp: 1000,
        exceeded: true,
      },
      week: {
        from: '2026-10-03',
        to: '2026-10-11',
        base: '100',
        change: '23',
        growthBp: 2380,
        thresholdBp: 3000,
        exceeded: false,
      },
      minCirculation: '1000000',
    },
    system: {
      bot: 'unresponsive',
      worker: 'online',
      jobsWithProblems: 1,
      pendingMessages: 2,
      deadMessages: 3,
      failedRuns24h: 1,
    },
    ...over,
  };
}

function system(over: Partial<SystemView> = {}): SystemView {
  return {
    now: '2026-10-12T12:00:00Z',
    summary: {
      bot: 'never',
      worker: 'online',
      jobsWithProblems: 0,
      pendingMessages: 0,
      deadMessages: 1,
      failedRuns24h: 0,
    },
    services: [
      {
        service: 'worker',
        instance: 'host:12:abc',
        state: 'online',
        startedAt: '2026-10-12T10:00:00Z',
        lastSeenAt: '2026-10-12T11:59:50Z',
        stoppedAt: null,
        details: {},
      },
    ],
    jobs: [
      {
        name: 'settlement',
        nextRunAt: '2026-10-12T11:40:00Z',
        lastStartedAt: '2026-10-12T11:30:00Z',
        lastFinishedAt: '2026-10-12T11:30:01Z',
        lastError: 'Connection terminated',
        consecutiveFailures: 2,
        running: false,
        overdue: true,
        recentRuns: [],
      },
    ],
    recentFailures: [],
    outbox: {
      pending: 0,
      dead: 1,
      sent24h: 7,
      oldestPendingAt: null,
      senderActive: true,
      deadMessages: [
        {
          id: 41,
          platform: 'rubika',
          kind: 'send',
          status: 'dead',
          chatId: 'g0sample6',
          group: { id: 7, title: '<b>شهر</b>' },
          text: '<img src=x onerror=alert(1)>',
          attempts: 8,
          lastError: 'Forbidden: bot was kicked',
          createdAt: '2026-10-12T08:00:00Z',
          nextAttemptAt: '2026-10-12T08:10:00Z',
        },
      ],
    },
    ...over,
  };
}

function withDashboard(data: DashboardView): FakeApi {
  const fake = installFakeApi();
  fake.routes['GET /api/dashboard'] = () => ({ status: 200, body: data });
  return fake;
}

describe('dashboard page', () => {
  it('shows the headline numbers in Persian, with the inflation warning', async () => {
    withDashboard(dashboard());
    renderPanel('/');
    expect(await screen.findByText('بازیکن فعال امروز')).toBeTruthy();
    expect(screen.getByText('۱۲')).toBeTruthy();
    expect(screen.getByText('۳۳٬۹۵۶')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('هشدار تورم');
    expect(alert.textContent).toContain('۲۳٫۸٪');
    expect(alert.textContent).toContain('آستانه ۱۰٪');
    // The weekly measure did not exceed its threshold, so it is not listed.
    expect(alert.textContent).not.toContain('۷ روز');
  });

  it('switches the production and consumption period', async () => {
    withDashboard(dashboard());
    renderPanel('/');
    expect(await screen.findByText('لولو')).toBeTruthy();
    expect(screen.getByText('خرید ابزار')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '۷ روز' }));
    expect(screen.getByText('استریک')).toBeTruthy();
    expect(screen.queryByText('لولو')).toBeNull();
  });

  it('offers the circulation chart as a table', async () => {
    withDashboard(dashboard());
    renderPanel('/');
    fireEvent.click(await screen.findByRole('button', { name: 'جدول' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(32);
    // Newest first: today's 31 000 points in the cash and total columns.
    expect(within(table).getAllByText('۳۱٬۰۰۰')).toHaveLength(2);
    expect(within(table).getByText('۲۰ مهر ۱۴۰۵')).toBeTruthy();
  });

  it('shows the system summary with labelled states', async () => {
    withDashboard(dashboard());
    renderPanel('/');
    expect(await screen.findByText('بی‌پاسخ')).toBeTruthy();
    expect(screen.getByText('روشن')).toBeTruthy();
    expect(screen.getByText('۱ کار مشکل دارد')).toBeTruthy();
  });

  it('shows the server error and recovers on retry', async () => {
    const fake = installFakeApi();
    fake.routes['GET /api/dashboard'] = () => failure(500, 'internal', 'خطای داخلی سرور.');
    renderPanel('/');
    expect((await screen.findByRole('alert')).textContent).toContain('خطای داخلی سرور.');
    fake.routes['GET /api/dashboard'] = () => ({ status: 200, body: dashboard() });
    fireEvent.click(screen.getByRole('button', { name: 'دوباره' }));
    expect(await screen.findByText('بازیکن فعال امروز')).toBeTruthy();
  });

  it('notes when circulation is too small to judge', async () => {
    withDashboard(
      dashboard({
        inflation: { ...dashboard().inflation, status: 'not_enough_data' },
      }),
    );
    renderPanel('/');
    expect(await screen.findByText(/وقتی سنجیده می‌شود که دست‌کم ۱۰٬۰۰۰ پوینت/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('system page', () => {
  it('shows untrusted message text and group names as plain text', async () => {
    const fake = installFakeApi();
    fake.routes['GET /api/system'] = () => ({ status: 200, body: system() });
    const { container } = renderPanel('/system');
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<b>شهر</b>')).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('روبیکا')).toBeTruthy();
    expect(screen.getByText(/عقب افتاده/)).toBeTruthy();
    expect(screen.getByText('Connection terminated')).toBeTruthy();
    expect(screen.getByText('ارسال‌کننده فعال است.')).toBeTruthy();
  });

  it('retries a failed message with the CSRF token and refreshes', async () => {
    const fake = installFakeApi();
    let dead = true;
    fake.routes['GET /api/system'] = () => ({
      status: 200,
      body: dead ? system() : system({ outbox: { ...system().outbox, dead: 0, deadMessages: [] } }),
    });
    fake.routes['POST /api/system/outbox/41/retry'] = () => {
      dead = false;
      return { status: 200, body: { status: 'pending' } };
    };
    renderPanel('/system');
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال دوباره' }));
    expect(await screen.findByText('پیام ناموفقی نیست.')).toBeTruthy();
    const call = fake.calls.find((c) => c.path === '/api/system/outbox/41/retry')!;
    expect((call.init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
  });

  it('notes the simulated sender in dev:panel', async () => {
    const fake = installFakeApi(sessionFor({}, 'dev-panel'));
    fake.routes['GET /api/system'] = () => ({ status: 200, body: system() });
    fake.routes['GET /api/system/backups'] = () => ({
      status: 200,
      body: { backups: [], keep: 10 },
    });
    renderPanel('/system');
    expect(await screen.findByText(/ارسال شبیه‌سازی می‌شود/)).toBeTruthy();
  });

  it('hides backups from admins', async () => {
    const fake = installFakeApi(sessionFor({ role: 'admin' }));
    fake.routes['GET /api/system'] = () => ({ status: 200, body: system() });
    renderPanel('/system');
    expect(await screen.findByText('صف ارسال پیام')).toBeTruthy();
    expect(screen.queryByText('بکاپ')).toBeNull();
    expect(fake.calls.some((c) => c.path === '/api/system/backups')).toBe(false);
  });

  it('asks the owner for the password before a backup', async () => {
    const fake = installFakeApi();
    const backups: { name: string; bytes: number; createdAt: string }[] = [];
    fake.routes['GET /api/system'] = () => ({ status: 200, body: system() });
    fake.routes['GET /api/system/backups'] = () => ({ status: 200, body: { backups, keep: 10 } });
    fake.routes['POST /api/system/backups'] = (init) => {
      const { password } = JSON.parse(init.body as string) as { password: string };
      if (password !== 'right') return failure(403, 'wrong_password', 'رمز درست نیست.');
      const made = {
        name: 'lulu-backup-20261012-120000Z.jsonl.gz',
        bytes: 2048,
        createdAt: '2026-10-12T12:00:00Z',
      };
      backups.push(made);
      return { status: 200, body: { ...made, sha256: 'ab'.repeat(32), rows: {} } };
    };
    renderPanel('/system');
    expect(await screen.findByText('هنوز بکاپی ساخته نشده است.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'گرفتن بکاپ' }));
    const input = screen.getByLabelText(/رمز خودتان را دوباره وارد کنید/);
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'ساختن بکاپ' }));
    expect((await screen.findByRole('alert')).textContent).toBe('رمز درست نیست.');

    fireEvent.change(screen.getByLabelText(/رمز خودتان را دوباره وارد کنید/), {
      target: { value: 'right' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ساختن بکاپ' }));
    expect(await screen.findByText(/بکاپ ساخته شد/)).toBeTruthy();
    const link = await screen.findByRole('link', { name: 'دانلود' });
    expect(link.getAttribute('href')).toBe(
      '/api/system/backups/lulu-backup-20261012-120000Z.jsonl.gz',
    );
    await waitFor(() => expect(screen.queryByLabelText(/رمز خودتان/)).toBeNull());
  });
});
