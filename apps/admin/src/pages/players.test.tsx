// @vitest-environment jsdom
import type {
  PlayerDetailView,
  PlayerListView,
  TransactionListView,
  TransactionView,
} from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeApi } from '../testing.tsx';
import { failure, installFakeApi, renderPanel } from '../testing.tsx';
import { pointsInput } from './player.tsx';
import { draftToParams } from './transactions.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const listItem = (id: number, name: string) => ({
  id,
  displayName: name,
  username: id === 1 ? 'sara' : null,
  isSample: id === 2,
  bannedAt: id === 3 ? '2026-10-10T10:00:00Z' : null,
  createdAt: '2026-09-01T10:00:00Z',
  level: 2,
  levelName: 'اسکلت',
  cash: '150050',
  treasury: '50000',
  identities: [
    { platform: id === 2 ? ('rubika' as const) : ('telegram' as const), platformUserId: `9${id}` },
  ],
  lastActiveAt: '2026-10-12T09:00:00Z',
});

const tx = (id: number, over: Partial<TransactionView> = {}): TransactionView => ({
  id,
  kind: 'lolo_reward',
  kindName: 'پاداش لولو',
  effectiveAt: '2026-10-12T10:00:00Z',
  recordedAt: '2026-10-12T10:00:00Z',
  user: { id: 7, displayName: 'سارا' },
  group: { id: 3, title: 'شهر' },
  admin: null,
  reason: null,
  amount: '500',
  playerDelta: '500',
  entries: [
    { account: 'system', userId: null, groupId: null, systemCode: 'mint:lolo', amount: '-500' },
    { account: 'cash', userId: 7, groupId: null, systemCode: null, amount: '500' },
  ],
  ...over,
});

function detail(over: Partial<PlayerDetailView['user']> = {}): PlayerDetailView {
  return {
    user: {
      id: 7,
      displayName: '<script>سارا</script>',
      username: 'sara',
      isSample: false,
      createdAt: '2026-09-01T10:00:00Z',
      bannedAt: null,
      banReason: null,
      ...over,
    },
    identities: [
      { platform: 'telegram', platformUserId: '777001', createdAt: '2026-09-01T10:00:00Z' },
    ],
    level: 2,
    levelName: 'اسکلت',
    maxLevel: 6,
    nextLevelCost: '600000',
    cash: '10000',
    treasury: '0',
    tools: { owned: [{ kind: 'knife', name: 'چاقو' }], equipped: { kind: 'knife', name: 'چاقو' } },
    inventory: [{ kind: 'bone', name: 'استخوان', count: 3 }],
    meals: { active: [], capacity: 1 },
    cemetery: null,
    waits: [],
    ghostsToday: { found: 0, limit: 3 },
    groups: [
      {
        groupId: 3,
        title: 'شهر <b>تاریک</b>',
        platform: 'telegram',
        botPresent: true,
        status: 'member',
        joinedAt: '2026-09-01T10:00:00Z',
        lastSuccessAt: '2026-10-12T09:00:00Z',
        streak: 4,
      },
    ],
    ghosts: { foundTotal: 2, heardTotal: 1, recent: [] },
    streakRewards: [],
  };
}

function withTransactions(fake: FakeApi, pages: Record<string, TransactionListView>) {
  fake.routes['GET /api/transactions/kinds'] = () => ({
    status: 200,
    body: [
      { kind: 'lolo_reward', name: 'پاداش لولو' },
      { kind: 'admin_adjustment', name: 'اصلاح مدیر' },
    ],
  });
  for (const [query, body] of Object.entries(pages)) {
    fake.routes[`GET /api/transactions${query}`] = () => ({ status: 200, body });
  }
}

describe('players list', () => {
  it('searches from the URL and shows badges, platform and untrusted names as text', async () => {
    const fake = installFakeApi();
    const list: PlayerListView = {
      items: [
        listItem(1, '<img src=x onerror=alert(1)>'),
        listItem(2, 'نمونه'),
        listItem(3, 'مسدود'),
      ],
      total: 60,
      page: 1,
      pageSize: 25,
    };
    fake.routes['GET /api/players?'] = () => ({ status: 200, body: list });
    fake.routes['GET /api/players?q=sara'] = () => ({
      status: 200,
      body: { ...list, items: [list.items[0]], total: 1 },
    });
    fake.routes['GET /api/players?page=2'] = () => ({ status: 200, body: { ...list, page: 2 } });
    const { container } = renderPanel('/players');

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('نمونه', { selector: 'span.rounded-full' })).toBeTruthy();
    expect(screen.getByText('مسدود', { selector: 'span.rounded-full' })).toBeTruthy();
    expect(screen.getByText('روبیکا', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText(/۲٬۰۰۰٫۵/)).toHaveLength(3);
    expect(screen.getByText('صفحهٔ ۱ از ۳')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'بعدی' }));
    await waitFor(() =>
      expect(fake.calls.some((c) => c.path === '/api/players?page=2')).toBe(true),
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sara' } });
    fireEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));
    expect(await screen.findByText('۱ بازیکن')).toBeTruthy();
  });
});

describe('player profile', () => {
  function setup(user: Partial<PlayerDetailView['user']> = {}) {
    const fake = installFakeApi();
    fake.routes['GET /api/players/7'] = () => ({ status: 200, body: detail(user) });
    withTransactions(fake, {
      '?userId=7': { items: [tx(1)], next: null, summary: { count: 1, amount: '500' } },
    });
    renderPanel('/players/7');
    return fake;
  }

  it('shows the profile, groups and history with untrusted text escaped', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: '<script>سارا</script>' })).toBeTruthy();
    expect(screen.getByText('شهر <b>تاریک</b>')).toBeTruthy();
    expect(screen.getByText(/استریک: ۴ روز/)).toBeTruthy();
    expect(screen.getByText('777001')).toBeTruthy();
    expect(await screen.findByText('پاداش لولو')).toBeTruthy();
    expect(screen.getByText(/\+۵\S* برای بازیکن/)).toBeTruthy();
  });

  it('gives points only after a preview and a confirmation, with one key per form', async () => {
    const fake = setup();
    const bodies: unknown[] = [];
    fake.routes['POST /api/players/7/adjust'] = (init) => {
      bodies.push(JSON.parse(init.body as string));
      return { status: 200, body: { transactionId: 9, balance: '35050', duplicate: false } };
    };
    fireEvent.click(await screen.findByRole('button', { name: 'دادن یا کم کردن پوینت' }));
    fireEvent.change(screen.getByLabelText('مبلغ (پوینت)'), { target: { value: '۲۵۰٫۵' } });
    fireEvent.change(screen.getByLabelText(/دلیل/), { target: { value: 'جبران باگ' } });
    expect(screen.getByText(/۱۰۰ ←/).textContent).toContain('۳۵۰٫۵');

    fireEvent.click(screen.getByRole('button', { name: 'بررسی' }));
    expect(screen.getByText(/تاریخچهٔ قبلی تغییر نمی‌کند/)).toBeTruthy();
    expect(bodies).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'تأیید و ثبت' }));
    expect(await screen.findByText(/ثبت شد. موجودی تازهٔ نقد: ۳۵۰٫۵/)).toBeTruthy();
    expect(bodies[0]).toMatchObject({ wallet: 'cash', amount: '250.50', reason: 'جبران باگ' });
    expect((bodies[0] as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('will not take more than the balance, and shows the server’s refusal', async () => {
    const fake = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'دادن یا کم کردن پوینت' }));
    fireEvent.click(screen.getByLabelText('کم کردن'));
    fireEvent.change(screen.getByLabelText('مبلغ (پوینت)'), { target: { value: '101' } });
    fireEvent.change(screen.getByLabelText(/دلیل/), { target: { value: 'x' } });
    expect(screen.getByText('موجودی منفی نمی‌شود.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'بررسی' })).toHaveProperty('disabled', true);

    fake.routes['POST /api/players/7/adjust'] = () =>
      failure(
        409,
        'conflict',
        'موجودی کافی نیست؛ موجودی فعلی 50.00 پوینت است و موجودی منفی نمی‌شود.',
      );
    fireEvent.change(screen.getByLabelText('مبلغ (پوینت)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'بررسی' }));
    fireEvent.click(screen.getByRole('button', { name: 'تأیید و ثبت' }));
    expect((await screen.findByRole('alert')).textContent).toContain('موجودی کافی نیست');
  });

  it('bans with a required reason', async () => {
    const fake = setup();
    let body: unknown;
    fake.routes['POST /api/players/7/ban'] = (init) => {
      body = JSON.parse(init.body as string);
      return { status: 200, body: { banned: true } };
    };
    fireEvent.click(await screen.findByRole('button', { name: 'مسدود کردن' }));
    const confirm = screen.getByRole('button', { name: 'مسدود کن' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('دلیل (اجباری)'), { target: { value: 'تقلب' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('بازیکن مسدود شد.')).toBeTruthy();
    expect(body).toEqual({ banned: true, reason: 'تقلب' });
  });

  it('shows the ban and offers to lift it', async () => {
    setup({ bannedAt: '2026-10-10T10:00:00Z', banReason: 'چند حساب' });
    expect(await screen.findByText(/دلیل: چند حساب/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'رفع مسدودی' })).toBeTruthy();
  });
});

describe('transactions page', () => {
  it('turns Jalali filters into API days, and refuses bad ones without calling the API', async () => {
    const fake = installFakeApi();
    withTransactions(fake, {
      '?': { items: [tx(1)], next: null, summary: { count: 1, amount: '500' } },
      '?userId=7&from=2026-09-23&to=2026-10-12&min=12.5': {
        items: [tx(2, { reason: '=1+1' })],
        next: 'Y3Vyc29y',
        summary: { count: 51, amount: '9000' },
      },
      '?userId=7&from=2026-09-23&to=2026-10-12&min=12.5&cursor=Y3Vyc29y': {
        items: [tx(3)],
        next: null,
        summary: null,
      },
    });
    renderPanel('/transactions');
    expect(await screen.findByText('۱ تراکنش', { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('از تاریخ (شمسی)'), { target: { value: '۱۴۰۵/۱۳/۰۱' } });
    fireEvent.click(screen.getByRole('button', { name: 'اعمال فیلتر' }));
    expect(screen.getByText('تاریخ شمسی مثل ۱۴۰۵/۰۷/۲۰ بنویسید.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('شناسهٔ بازیکن'), { target: { value: '۷' } });
    fireEvent.change(screen.getByLabelText('از تاریخ (شمسی)'), { target: { value: '۱۴۰۵/۰۷/۰۱' } });
    fireEvent.change(screen.getByLabelText('تا تاریخ (شمسی)'), { target: { value: '1405/7/20' } });
    fireEvent.change(screen.getByLabelText('مبلغ از (پوینت)'), { target: { value: '۱۲٫۵' } });
    fireEvent.click(screen.getByRole('button', { name: 'اعمال فیلتر' }));

    expect(await screen.findByText('دلیل: =1+1')).toBeTruthy();
    expect(screen.getByText(/۵۱ تراکنش/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'خروجی CSV' });
    expect(link.getAttribute('href')).toBe(
      '/api/transactions/export.csv?userId=7&from=2026-09-23&to=2026-10-12&min=12.5',
    );

    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => expect(screen.getByText('صفحهٔ ۲')).toBeTruthy());
    expect(fake.calls.some((c) => c.path.endsWith('cursor=Y3Vyc29y'))).toBe(true);
    // The total stays from the first page.
    expect(screen.getByText(/۵۱ تراکنش/)).toBeTruthy();
    within(screen.getByRole('navigation', { name: 'صفحه‌ها' })).getByRole('button', {
      name: /جدیدتر/,
    });
  });
});

describe('form parsing', () => {
  it('reads amounts in Persian digits exactly', () => {
    expect(pointsInput('۲۵۰٫۵')).toBe(25_050n);
    expect(pointsInput('12')).toBe(1_200n);
    expect(pointsInput('1.234')).toBeNull();
    expect(pointsInput('-5')).toBeNull();
  });

  it('builds API filters from a draft', () => {
    const empty = { userId: '', groupId: '', kind: '', from: '', to: '', min: '', max: '' };
    expect(draftToParams({ ...empty, from: '۱۴۰۵/۰۷/۲۰', to: '۱۴۰۵/۰۷/۰۱' }).errors).toEqual({
      to: '«تا» نباید پیش از «از» باشد.',
    });
    expect(draftToParams({ ...empty, groupId: 'abc', max: '۱۰٬۰۰۰' })).toEqual({
      params: { max: '10000' },
      errors: { groupId: 'شناسه باید عدد باشد.' },
    });
  });
});
