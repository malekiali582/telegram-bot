// @vitest-environment jsdom
import type {
  AccountView,
  AdminListItemView,
  AuditEntryView,
  AuditListView,
} from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceLabel } from '../lib/labels.ts';
import { failure, installFakeApi, renderPanel, sessionFor } from '../testing.tsx';
import { randomPassword } from './admins.tsx';
import { auditDraftToParams } from './audit.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const admin = (over: Partial<AdminListItemView>): AdminListItemView => ({
  id: 1,
  username: 'owner',
  role: 'owner',
  createdAt: '2026-10-01T08:00:00Z',
  disabledAt: null,
  lastLoginAt: '2026-10-14T07:00:00Z',
  activeSessions: 1,
  you: true,
  ...over,
});
const ADMINS = [
  admin({}),
  admin({ id: 2, username: 'helper', role: 'admin', you: false, activeSessions: 2 }),
  admin({
    id: 3,
    username: 'gone',
    role: 'admin',
    you: false,
    disabledAt: '2026-10-10T08:00:00Z',
    activeSessions: 0,
  }),
];

describe('admins page', () => {
  it('is not in the panel for an admin', async () => {
    installFakeApi(sessionFor({ role: 'admin', username: 'helper' }));
    renderPanel('/admins');
    expect(await screen.findByText(/پیدا نشد/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /مدیران/ })).toBeNull();
  });

  it('lists accounts and offers only the actions that make sense for each', async () => {
    const fake = installFakeApi(sessionFor());
    fake.routes['GET /api/admins'] = () => ({ status: 200, body: ADMINS });
    renderPanel('/admins');
    const me = (await screen.findByText('شما')).closest('li')!;
    expect(within(me).queryByRole('button', { name: /حذف/ })).toBeNull();
    expect(within(me).queryByRole('button', { name: /رمز تازه/ })).toBeNull();
    expect(within(me).getByRole('button', { name: /مدیر عادی شود/ })).toBeTruthy();

    const helper = screen.getByText('helper').closest('li')!;
    expect(within(helper).getByText(/۲ نشست باز/)).toBeTruthy();
    expect(within(helper).getByRole('button', { name: /مالک شود/ })).toBeTruthy();
    const gone = screen.getByText('gone').closest('li')!;
    expect(within(gone).getByText(/حذف‌شده/)).toBeTruthy();
    expect(
      within(gone)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['برگرداندن']);
  });

  it('removes an admin after the owner re-enters the password, showing a refusal as is', async () => {
    const fake = installFakeApi(sessionFor());
    fake.routes['GET /api/admins'] = () => ({ status: 200, body: ADMINS });
    const bodies: unknown[] = [];
    fake.routes['POST /api/admins/2/disable'] = (init) => {
      const body = JSON.parse(init.body as string) as { password: string };
      bodies.push(body);
      return body.password === 'right'
        ? { status: 200, body: { ok: true } }
        : failure(403, 'wrong_password', 'رمز درست نیست.');
    };
    renderPanel('/admins');
    const row = (await screen.findByText('helper')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /حذف/ }));
    expect(within(row).getByText(/حساب پاک نمی‌شود تا سابقهٔ کارهایش بماند/)).toBeTruthy();
    const confirm = within(row).getByRole('button', { name: 'حذف کن' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(within(row).getByLabelText('دلیل (اختیاری)'), {
      target: { value: 'پایان همکاری' },
    });
    fireEvent.change(within(row).getByLabelText(/رمز خودتان/), { target: { value: 'wrong' } });
    fireEvent.click(confirm);
    expect((await within(row).findByRole('alert')).textContent).toBe('رمز درست نیست.');
    fireEvent.change(within(row).getByLabelText(/رمز خودتان/), { target: { value: 'right' } });
    fireEvent.click(within(row).getByRole('button', { name: 'حذف کن' }));
    expect(await screen.findByText(/«helper» حذف شد/)).toBeTruthy();
    expect(bodies.at(-1)).toEqual({ disabled: true, reason: 'پایان همکاری', password: 'right' });
  });

  it('adds an admin with a generated password', async () => {
    const fake = installFakeApi(sessionFor());
    fake.routes['GET /api/admins'] = () => ({ status: 200, body: ADMINS });
    let body: Record<string, string> = {};
    fake.routes['POST /api/admins'] = (init) => {
      body = JSON.parse(init.body as string) as Record<string, string>;
      return { status: 200, body: { id: 4 } };
    };
    renderPanel('/admins');
    fireEvent.click(await screen.findByRole('button', { name: /مدیر تازه/ }));
    fireEvent.change(screen.getByLabelText(/نام کاربری/), { target: { value: 'Scribe' } });
    fireEvent.click(screen.getByRole('button', { name: 'رمز تصادفی' }));
    const generated = screen.getByLabelText<HTMLInputElement>(/رمز تازهٔ او/).value;
    expect(generated).toHaveLength(20);
    fireEvent.click(screen.getByLabelText('مالک'));
    expect(screen.getByText(/مالک همه‌کار می‌کند/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/رمز خودتان/), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'ساختن حساب' }));
    expect(await screen.findByText(/حساب «scribe» ساخته شد/)).toBeTruthy();
    expect(body).toEqual({
      username: 'Scribe',
      newPassword: generated,
      role: 'owner',
      password: 'mine',
    });
  });

  it('generates passwords from an unambiguous alphabet', () => {
    const p = randomPassword();
    expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/);
    expect(randomPassword()).not.toBe(p);
  });
});

describe('my account page', () => {
  const account: AccountView = {
    user: { id: 2, username: 'helper', role: 'admin' },
    createdAt: '2026-10-01T08:00:00Z',
    passwordMinLength: 12,
    sessions: [
      {
        id: 'aaaaaaaaaaaaaaaa',
        createdAt: '2026-10-14T07:00:00Z',
        lastSeenAt: '2026-10-14T08:00:00Z',
        expiresAt: '2026-10-14T19:00:00Z',
        ip: '127.0.0.1',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
        current: true,
      },
      {
        id: 'bbbbbbbbbbbbbbbb',
        createdAt: '2026-10-13T07:00:00Z',
        lastSeenAt: '2026-10-14T06:00:00Z',
        expiresAt: '2026-10-14T19:00:00Z',
        ip: '10.0.0.8',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
        current: false,
      },
    ],
  };

  it('changes the password only when the new one is long enough and repeated', async () => {
    const fake = installFakeApi(sessionFor({ id: 2, role: 'admin', username: 'helper' }));
    fake.routes['GET /api/account'] = () => ({ status: 200, body: account });
    let body: unknown;
    fake.routes['POST /api/account/password'] = (init) => {
      body = JSON.parse(init.body as string);
      return { status: 200, body: { ok: true } };
    };
    renderPanel('/account');
    fireEvent.change(await screen.findByLabelText('رمز فعلی'), { target: { value: 'old one' } });
    fireEvent.change(screen.getByLabelText(/^رمز تازه/), { target: { value: 'short' } });
    expect(screen.getByText('رمز تازه باید دست‌کم ۱۲ نویسه باشد.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^رمز تازه/), {
      target: { value: 'long enough passphrase' },
    });
    fireEvent.change(screen.getByLabelText('تکرار رمز تازه'), { target: { value: 'different' } });
    expect(screen.getByText('با رمز تازه یکی نیست.')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'تغییر رمز' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('تکرار رمز تازه'), {
      target: { value: 'long enough passphrase' },
    });
    fireEvent.click(submit);
    expect(await screen.findByText('رمز عوض شد و نشست‌های دیگر بسته شدند.')).toBeTruthy();
    expect(body).toEqual({ currentPassword: 'old one', newPassword: 'long enough passphrase' });
  });

  it('lists sessions by device and signs out another one', async () => {
    const fake = installFakeApi(sessionFor({ id: 2, role: 'admin', username: 'helper' }));
    fake.routes['GET /api/account'] = () => ({ status: 200, body: account });
    const calls: string[] = [];
    fake.routes['POST /api/account/sessions/bbbbbbbbbbbbbbbb/revoke'] = () => {
      calls.push('one');
      return { status: 200, body: { ok: true } };
    };
    fake.routes['POST /api/account/sessions/revoke-others'] = () => {
      calls.push('others');
      return { status: 200, body: { revoked: 1 } };
    };
    renderPanel('/account');
    const current = (await screen.findByText('همین مرورگر')).closest('li')!;
    expect(within(current).getByText(/Edge روی Windows/)).toBeTruthy();
    expect(within(current).queryByRole('button')).toBeNull();
    const phone = screen.getByText('Chrome روی Android').closest('li')!;
    fireEvent.click(within(phone).getByRole('button', { name: /خروج این نشست/ }));
    fireEvent.click(screen.getByRole('button', { name: 'خروج از همهٔ نشست‌های دیگر' }));
    await waitFor(() => expect(calls).toEqual(['one', 'others']));
  });

  it('names devices from the user agent', () => {
    expect(deviceLabel(null)).toBe('مرورگر ناشناس');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/604.1')).toBe(
      'Safari روی iOS',
    );
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko Firefox/130.0')).toBe(
      'Firefox روی Linux',
    );
  });
});

describe('audit log page', () => {
  const entry = (over: Partial<AuditEntryView>): AuditEntryView => ({
    id: 1,
    createdAt: '2026-10-14T08:00:00Z',
    actor: 'admin',
    admin: { id: 2, username: 'helper' },
    action: 'group.disable',
    targetType: 'group',
    targetId: '42',
    targetName: '<b>برج</b>',
    reason: 'اسپم',
    details: {},
    requestId: 'req-9',
    ...over,
  });

  it('shows entries with Persian labels and links, and filters by Jalali dates', async () => {
    const fake = installFakeApi(sessionFor({ role: 'admin', username: 'helper' }));
    fake.routes['GET /api/audit/filters'] = () => ({
      status: 200,
      body: {
        admins: [{ id: 2, username: 'helper' }],
        actions: ['group.disable', 'balance.adjust'],
        targetTypes: ['group', 'user'],
      },
    });
    const list = (items: AuditEntryView[]): AuditListView => ({
      items,
      total: items.length,
      page: 1,
      pageSize: 50,
    });
    fake.routes['GET /api/audit?'] = () => ({
      status: 200,
      body: list([
        entry({}),
        entry({
          id: 2,
          action: 'balance.adjust',
          targetType: 'user',
          targetId: '7',
          targetName: 'سارا',
          details: { amount: '500.00' },
        }),
      ]),
    });
    fake.routes['GET /api/audit?action=group.disable&from=2026-10-12'] = () => ({
      status: 200,
      body: list([entry({})]),
    });
    const { container } = renderPanel('/audit');
    expect(await screen.findByText('غیرفعال کردن گروه', { selector: 'span' })).toBeTruthy();
    const link = screen.getByRole('link', { name: /گروه «<b>برج<\/b>»/ });
    expect(link.getAttribute('href')).toBe('/groups/42');
    expect(container.querySelector('main b')).toBeNull();
    expect(screen.getAllByText('دلیل: اسپم')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /بازیکن «سارا»/ }).getAttribute('href')).toBe(
      '/players/7',
    );
    expect(screen.getByText('500.00')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('از تاریخ (شمسی)'), {
      target: { value: '۱۴۰۵/۰۷/۲۰' },
    });
    fireEvent.change(screen.getByLabelText('نوع کار'), { target: { value: 'group.disable' } });
    expect(await screen.findByText('۱ مورد')).toBeTruthy();
  });

  it('turns typed filters into API parameters, or explains the problem', () => {
    const empty = { admin: '', action: '', targetType: '', targetId: '', from: '', to: '', q: '' };
    expect(auditDraftToParams({ ...empty, targetId: '۴۲', q: ' اسپم ', admin: 'system' })).toEqual({
      params: { admin: 'system', targetId: '42', q: 'اسپم' },
      errors: {},
    });
    expect(auditDraftToParams({ ...empty, from: '1405/13/01' }).errors.from).toContain('شمسی');
    expect(auditDraftToParams({ ...empty, from: '1405/07/20', to: '1405/07/10' }).errors.to).toBe(
      '«تا» نباید پیش از «از» باشد.',
    );
  });
});
