// @vitest-environment jsdom
import type {
  GroupDetailView,
  GroupListView,
  GroupMigrationItemView,
  MigrationOverviewView,
} from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, renderPanel } from '../testing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (id: number, title: string, over: Partial<GroupListView['items'][number]> = {}) => ({
  id,
  title,
  isSample: false,
  platform: 'telegram' as const,
  chatId: `-100${id}`,
  botPresent: true,
  disabledAt: null,
  createdAt: '2026-09-01T10:00:00Z',
  cityLevel: 2,
  bloodBank: '123450',
  members: 12,
  activeMembers: 7,
  lastActivityAt: '2026-10-14T09:00:00Z',
  previousChatIds: 0,
  ...over,
});

const conflict: GroupMigrationItemView = {
  id: 9,
  platform: 'telegram',
  fromChatId: '-1001',
  toChatId: '-1002',
  groupId: 3,
  groupTitle: 'الف',
  status: 'conflict',
  otherGroup: { id: 4, title: 'پر' },
  absorbedGroupId: null,
  detectedAt: '2026-10-14T09:00:00Z',
  review: null,
};

function detail(disabled = false): GroupDetailView {
  return {
    group: {
      id: 3,
      title: '<img src=x onerror=alert(1)>',
      isSample: false,
      botPresent: true,
      botAddedAt: '2026-09-01T10:00:00Z',
      botRemovedAt: null,
      createdAt: '2026-09-01T10:00:00Z',
      disabledAt: disabled ? '2026-10-14T08:00:00Z' : null,
      disabledReason: disabled ? 'اسپم' : null,
    },
    identity: { platform: 'telegram', chatId: '-1002', since: '2026-10-01T10:00:00Z' },
    previousChatIds: [
      { platform: 'telegram', chatId: '-1001', replacedAt: '2026-10-01T10:00:00Z' },
    ],
    city: {
      level: 2,
      maxLevel: 6,
      population: { active: 7, windowDays: 7, requiredForNext: 15 },
      huntStore: {
        points: 40,
        donatedTotal: 60,
        donatedByFood: [{ kind: 'bone', name: 'استخوان', count: 9 }],
      },
      bloodBank: { balance: '123450', level: 2, donatedTotal: '500000' },
      huntingGround: { level: 1, maxForBank: 2 },
      curses: [
        { kind: 'hunt_haste', name: 'شتاب شکار', level: 1, maxForBank: 2 },
        { kind: 'lolo_echo', name: 'پژواک لولو', level: 0, maxForBank: 2 },
      ],
      next: {
        city: { level: 3, bloodBankCost: '1000000', huntPointsCost: 100 },
        bloodBank: null,
        huntingGround: null,
      },
    },
    members: {
      total: 1,
      active: 1,
      left: 0,
      list: [
        {
          userId: 7,
          displayName: 'سارا',
          status: 'member',
          banned: false,
          joinedAt: '2026-09-01T10:00:00Z',
          lastSuccessAt: '2026-10-14T09:00:00Z',
          active: true,
        },
      ],
    },
    leaderboard: [{ rank: 1, userId: 7, displayName: 'سارا', points: '9900', levelName: 'اسکلت' }],
    migrations: [{ ...conflict, groupTitle: '<img src=x onerror=alert(1)>' }],
  };
}

describe('groups list', () => {
  it('shows state badges, platform, old ids and the conflicts link', async () => {
    const fake = installFakeApi();
    fake.routes['GET /api/groups?'] = () => ({
      status: 200,
      body: {
        items: [
          item(1, 'زنده'),
          item(2, 'خاموش', { disabledAt: '2026-10-14T08:00:00Z' }),
          item(3, 'رفته', { botPresent: false, platform: 'rubika', previousChatIds: 2 }),
        ],
        total: 3,
        page: 1,
        pageSize: 25,
      } satisfies GroupListView,
    });
    fake.routes['GET /api/groups?status=disabled'] = () => ({
      status: 200,
      body: { items: [item(2, 'خاموش')], total: 1, page: 1, pageSize: 25 },
    });
    renderPanel('/groups');
    expect(await screen.findByText('زنده')).toBeTruthy();
    expect(screen.getByText('غیرفعال', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('ربات حذف شده', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('۲ آیدی قدیمی')).toBeTruthy();
    expect(screen.getAllByText(/۷ از ۱۲/)).toHaveLength(3);
    expect(screen.getByRole('link', { name: /تعارض‌های مهاجرت/ }).getAttribute('href')).toBe(
      '/groups/migrations',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'وضعیت' }), {
      target: { value: 'disabled' },
    });
    expect(await screen.findByText('۱ گروه')).toBeTruthy();
  });
});

describe('group detail', () => {
  it('shows the city, members and history with untrusted titles as text, and disables with a reason', async () => {
    const fake = installFakeApi();
    let disabled = false;
    let body: unknown;
    fake.routes['GET /api/groups/3'] = () => ({ status: 200, body: detail(disabled) });
    fake.routes['GET /api/transactions?groupId=3'] = () => ({
      status: 200,
      body: { items: [], next: null, summary: { count: 0, amount: '0' } },
    });
    fake.routes['POST /api/groups/3/disable'] = (init) => {
      body = JSON.parse(init.body as string);
      disabled = true;
      return { status: 200, body: { disabled: true } };
    };
    const { container } = renderPanel('/groups/3');
    expect(
      await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' }),
    ).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('شتاب شکار')).toBeTruthy();
    expect(screen.getByText('استخوان ×۹')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'سارا' })[0]!.getAttribute('href')).toBe(
      '/players/7',
    );
    expect(screen.getAllByText('-1001')).toHaveLength(2); // id history and the migration
    expect(screen.getByText('تعارض')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'غیرفعال کردن گروه' }));
    const confirm = screen.getByRole('button', { name: 'غیرفعال کن' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('دلیل (اجباری)'), { target: { value: 'اسپم' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('گروه غیرفعال شد.')).toBeTruthy();
    expect(body).toEqual({ disabled: true, reason: 'اسپم' });
    await waitFor(() => expect(screen.getByText(/دلیل: اسپم/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'فعال کردن گروه' })).toBeTruthy();
  });
});

describe('migration conflicts page', () => {
  it('lists open conflicts and marks one as reviewed with a note', async () => {
    const fake = installFakeApi();
    let open = true;
    let note: unknown;
    fake.routes['GET /api/groups/migrations'] = () => ({
      status: 200,
      body: {
        openConflicts: open ? [conflict] : [],
        recent: [
          open
            ? conflict
            : {
                ...conflict,
                review: { at: '2026-10-14T10:00:00Z', adminUsername: 'helper', note: 'جدا' },
              },
        ],
        groupsWithPreviousIds: [
          {
            groupId: 5,
            title: 'سه‌بار',
            platform: 'telegram',
            chatId: '-1005',
            previous: [
              { chatId: '-1004', replacedAt: '2026-10-10T10:00:00Z' },
              { chatId: '-1003', replacedAt: '2026-10-01T10:00:00Z' },
            ],
          },
        ],
      } satisfies MigrationOverviewView,
    });
    fake.routes['POST /api/groups/migrations/9/review'] = (init) => {
      note = JSON.parse(init.body as string);
      open = false;
      return { status: 200, body: { reviewed: true } };
    };
    renderPanel('/groups/migrations');
    expect(await screen.findByText('تعارض‌های بررسی‌نشده (۱)')).toBeTruthy();
    expect(screen.getByText('۲ آیدی قدیمی')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/چه کردید/), { target: { value: 'جدا' } });
    fireEvent.click(screen.getByRole('button', { name: 'علامت «بررسی شد»' }));
    expect(await screen.findByText('تعارضی برای بررسی نیست.')).toBeTruthy();
    expect(note).toEqual({ note: 'جدا' });
    expect(screen.getByText(/بررسی شد: helper/)).toBeTruthy();
  });
});
