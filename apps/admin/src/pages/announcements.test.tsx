// @vitest-environment jsdom
import type {
  AnnouncementDetailView,
  AnnouncementListView,
  AnnouncementRecipientsView,
  AnnouncementView,
} from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeApi } from '../testing.tsx';
import { failure, installFakeApi, renderPanel, sessionFor } from '../testing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const recipients = (
  over: Partial<AnnouncementRecipientsView> = {},
): AnnouncementRecipientsView => ({
  count: 23,
  byPlatform: [
    { platform: 'telegram', count: 20 },
    { platform: 'rubika', count: 3 },
  ],
  sample: ['آبادی یک'],
  skipped: { disabled: 2, botRemoved: 1, otherPlatform: 0 },
  maxLength: 4096,
  ...over,
});

const announcement = (over: Partial<AnnouncementView> = {}): AnnouncementView => ({
  id: 5,
  text: '<script>alert(1)</script> سرور امشب به‌روز می‌شود',
  target: 'all_groups',
  group: null,
  silent: false,
  createdBy: 'helper',
  createdAt: '2026-10-14T08:00:00Z',
  cancelledAt: null,
  cancelledBy: null,
  counts: { total: 23, pending: 10, sent: 12, failed: 1, cancelled: 0 },
  lastSentAt: '2026-10-14T08:00:02Z',
  ...over,
});

function setup(list: AnnouncementView[] = []): FakeApi {
  const fake = installFakeApi(sessionFor({ role: 'admin', username: 'helper' }));
  fake.routes['GET /api/announcements/recipients'] = () => ({ status: 200, body: recipients() });
  fake.routes['GET /api/announcements?page=1'] = () => ({
    status: 200,
    body: { items: list, total: list.length, page: 1, pageSize: 20 } satisfies AnnouncementListView,
  });
  return fake;
}

describe('announcements page', () => {
  it('previews the text and the recipients, then sends to every group after confirming', async () => {
    const fake = setup();
    let sent: unknown;
    fake.routes['POST /api/announcements'] = (init) => {
      sent = JSON.parse(init.body as string);
      return { status: 200, body: { id: 6, recipients: 23 } };
    };
    renderPanel('/announcements');
    expect(await screen.findByText('۲۳ گروه')).toBeTruthy();
    expect(screen.getByText(/تلگرام ۲۰، روبیکا ۳/)).toBeTruthy();
    expect(screen.getByText(/بدون این‌ها: ۲ گروه غیرفعال، ۱ گروه که ربات در آن نیست/)).toBeTruthy();

    const send = screen.getByRole('button', { name: 'ارسال به ۲۳ گروه' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('متن اطلاعیه'), {
      target: { value: '  <b>سلام</b>\nبه‌روزرسانی امشب  ' },
    });
    fireEvent.click(screen.getByLabelText(/بی‌صدا/));
    expect(screen.getByText('پیش‌نمایش')).toBeTruthy();
    expect(screen.getByText(/<b>سلام<\/b>/, { selector: 'p' })).toBeTruthy(); // as typed
    expect(document.querySelector('main b')).toBeNull();

    fireEvent.click(send);
    expect(screen.getByText(/دست‌کم ۳ ثانیه طول می‌کشد/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'بله، بفرست' }));
    expect(await screen.findByText('اطلاعیه در صف ارسال به ۲۳ گروه قرار گرفت.')).toBeTruthy();
    expect(sent).toEqual({
      target: { kind: 'all_groups' },
      text: '  <b>سلام</b>\nبه‌روزرسانی امشب  ',
      silent: true,
    });
  });

  it('sends to one group picked by search, or preset from the group page', async () => {
    const fake = setup();
    fake.routes['GET /api/groups?q=%D8%A8%D8%B1%D8%AC'] = () => ({
      status: 200,
      body: {
        items: [
          {
            id: 42,
            title: 'برج تاریک',
            isSample: false,
            platform: 'telegram',
            chatId: '-1001',
            botPresent: true,
            disabledAt: null,
            createdAt: '2026-10-01T00:00:00Z',
            cityLevel: 1,
            bloodBank: '0',
            members: 3,
            activeMembers: 1,
            lastActivityAt: null,
            previousChatIds: 0,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      },
    });
    fake.routes['GET /api/announcements/recipients?groupId=42'] = () => ({
      status: 200,
      body: recipients({
        count: 1,
        byPlatform: [{ platform: 'telegram', count: 1 }],
        sample: ['برج تاریک'],
        skipped: { disabled: 0, botRemoved: 0, otherPlatform: 0 },
      }),
    });
    let sent: unknown;
    fake.routes['POST /api/announcements'] = (init) => {
      sent = JSON.parse(init.body as string);
      return { status: 200, body: { id: 7, recipients: 1 } };
    };
    renderPanel('/announcements');
    fireEvent.click(await screen.findByLabelText('یک گروه'));
    fireEvent.change(screen.getByLabelText(/جست‌وجوی گروه/), { target: { value: 'برج' } });
    fireEvent.click(await screen.findByRole('button', { name: /برج تاریک/ }));
    expect(await screen.findByText('برج تاریک', { selector: 'span.font-bold' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('متن اطلاعیه'), { target: { value: 'سلام' } });
    fireEvent.click(screen.getByRole('button', { name: 'ارسال به ۱ گروه' }));
    fireEvent.click(screen.getByRole('button', { name: 'بله، بفرست' }));
    await waitFor(() =>
      expect(sent).toEqual({ target: { kind: 'group', groupId: 42 }, text: 'سلام', silent: false }),
    );

    cleanup();
    setup().routes['GET /api/announcements/recipients?groupId=42'] = () => ({
      status: 200,
      body: recipients({
        count: 0,
        sample: [],
        skipped: { disabled: 0, botRemoved: 1, otherPlatform: 0 },
      }),
    });
    renderPanel('/announcements?group=42');
    expect(
      await screen.findByText(/این گروه پیام را دریافت نمی‌کند \(۱ گروه که ربات در آن نیست\)/),
    ).toBeTruthy();
  });

  it('refuses a text longer than the platform allows', async () => {
    setup();
    renderPanel('/announcements');
    await screen.findByText('۲۳ گروه');
    const box = screen.getByLabelText('متن اطلاعیه');
    fireEvent.change(box, { target: { value: 'ا'.repeat(4097) } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'ارسال به ۲۳ گروه' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows delivery progress, cancels what is waiting and retries failures', async () => {
    const fake = setup([announcement()]);
    const detail: AnnouncementDetailView = {
      ...announcement(),
      deliveries: [
        {
          groupId: 9,
          title: 'گروه خراب',
          platform: 'telegram',
          chatId: '-1009',
          status: 'dead',
          attempts: 1,
          lastError: 'Forbidden: bot was kicked',
          sentAt: null,
          nextAttemptAt: '2026-10-14T08:00:00Z',
        },
      ],
    };
    fake.routes['GET /api/announcements/5'] = () => ({ status: 200, body: detail });
    const calls: string[] = [];
    fake.routes['POST /api/announcements/5/cancel'] = () => {
      calls.push('cancel');
      return { status: 200, body: { cancelled: 10 } };
    };
    fake.routes['POST /api/announcements/5/retry'] = () => {
      calls.push('retry');
      return failure(409, 'conflict', 'پیام ناموفقی برای ارسال دوباره نیست.');
    };
    const { container } = renderPanel('/announcements');
    const item = (await screen.findByText(/سرور امشب به‌روز می‌شود/)).closest('li')!;
    expect(container.querySelector('script')).toBeNull();
    expect(within(item).getByText('۱۰ در صف')).toBeTruthy();
    expect(within(item).getByText('۱۲ ارسال‌شده')).toBeTruthy();
    expect(within(item).getByText('۱ ناموفق')).toBeTruthy();
    expect(within(item).getByRole('img').getAttribute('aria-label')).toBe('۱۲ از ۲۳ ارسال شد');

    fireEvent.click(within(item).getByRole('button', { name: /گیرنده‌ها/ }));
    expect(await within(item).findByText('Forbidden: bot was kicked')).toBeTruthy();

    fireEvent.click(within(item).getByRole('button', { name: 'لغو مانده‌ها' }));
    expect(within(item).getByText(/۱۰ پیامِ در صف لغو شود؟/)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'بله، لغو کن' }));
    await waitFor(() => expect(calls).toEqual(['cancel']));

    fireEvent.click(within(item).getByRole('button', { name: 'ارسال دوبارهٔ ناموفق‌ها' }));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'پیام ناموفقی برای ارسال دوباره نیست.',
    );
  });
});
