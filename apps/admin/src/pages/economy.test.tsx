// @vitest-environment jsdom
import type { ConfigFieldView, ConfigFormView, ConfigPreviewView } from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeApi } from '../testing.tsx';
import { failure, installFakeApi, renderPanel, sessionFor } from '../testing.tsx';
import { applyDraft } from './economy.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = (
  over: Partial<ConfigFieldView> & Pick<ConfigFieldView, 'path' | 'section'>,
): ConfigFieldView => ({
  label: 'suggested',
  description: 'توضیح',
  context: '',
  source: '§1',
  kind: 'integer',
  min: 0,
  nullable: false,
  readOnly: false,
  basisPoints: false,
  value: 0,
  ...over,
});

const CONFIG = {
  lolo: { cooldownSeconds: 300 },
  tools: { knife: { price: 500, successBp: 6000 } },
  levels: [{ level: 1, upgradeCost: null }],
};

function form(): ConfigFormView {
  return {
    versionId: 7,
    effectiveFrom: '2026-10-14T08:00:00Z',
    source: 'panel',
    note: 'قبلی',
    createdBy: 'owner',
    config: structuredClone(CONFIG),
    sections: [
      {
        key: 'lolo',
        title: 'لولو',
        fields: [
          field({
            path: 'lolo.cooldownSeconds',
            section: 'lolo',
            label: 'fixed',
            description: 'زمان انتظار لولو',
            value: 300,
          }),
        ],
      },
      {
        key: 'tools',
        title: 'ابزارها',
        fields: [
          field({
            path: 'tools.knife.price',
            section: 'tools',
            description: 'قیمت ابزار (پوینت)',
            context: 'چاقو',
            value: 500,
          }),
          field({
            path: 'tools.knife.successBp',
            section: 'tools',
            description: 'احتمال موفقیت',
            context: 'چاقو',
            value: 6000,
            basisPoints: true,
            max: 10_000,
          }),
        ],
      },
      {
        key: 'levels',
        title: 'سطح‌ها',
        fields: [
          field({
            path: 'levels[0].level',
            section: 'levels',
            description: 'شمارهٔ سطح',
            value: 1,
            readOnly: true,
            label: 'fixed',
          }),
          field({
            path: 'levels[0].upgradeCost',
            section: 'levels',
            description: 'هزینهٔ سطح بعد',
            value: null,
            readOnly: true,
          }),
        ],
      },
    ],
  };
}

function setup(
  role: 'owner' | 'admin',
  preview: (body: { config: typeof CONFIG }) => ConfigPreviewView,
): FakeApi {
  const fake = installFakeApi(sessionFor({ role, username: role }));
  fake.routes['GET /api/config'] = () => ({ status: 200, body: form() });
  fake.routes['POST /api/config/preview'] = (init) => ({
    status: 200,
    body: preview(JSON.parse(init.body as string) as { config: typeof CONFIG }),
  });
  return fake;
}

const change = (path: string, label: 'fixed' | 'suggested', before: number, after: number) => ({
  path,
  label,
  description: 'توضیح تغییر',
  context: 'چاقو',
  before,
  after,
});

describe('economy settings page', () => {
  it('lets an admin change a suggested value, review the diff and save it with a note', async () => {
    const fake = setup('admin', () => ({
      status: 'ok',
      baseVersionId: 7,
      changes: [change('tools.knife.price', 'suggested', 500, 450)],
      needsOwner: false,
    }));
    let saved: unknown;
    fake.routes['POST /api/config'] = (init) => {
      saved = JSON.parse(init.body as string);
      return { status: 200, body: { versionId: 8, changes: 1 } };
    };
    renderPanel('/economy');

    const fixed = await screen.findByLabelText('زمان انتظار لولو');
    expect(fixed).toHaveProperty('disabled', true);
    expect(screen.getByText(/· فقط مالک/)).toBeTruthy();
    expect(screen.getAllByText('قطعی').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('قیمت ابزار (پوینت) چاقو'), {
      target: { value: '۴۵۰' },
    });
    expect(screen.getByText('۱ تغییر ثبت‌نشده')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'بررسی و ثبت' }));

    expect(await screen.findByText('بررسی پیش از ثبت')).toBeTruthy();
    const noteField = await screen.findByLabelText(/توضیح تغییر/);
    expect(screen.getByText('توضیح تغییر')).toBeTruthy(); // the change, described
    const confirm = screen.getByRole('button', { name: 'ثبت نسخهٔ تازه' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(noteField, { target: { value: 'چاقوی ارزان‌تر' } });
    fireEvent.click(confirm);

    expect(await screen.findByText(/نسخهٔ ۸ با ۱ تغییر ثبت شد/)).toBeTruthy();
    expect(saved).toMatchObject({
      note: 'چاقوی ارزان‌تر',
      baseVersionId: 7,
      config: { tools: { knife: { price: 450 } }, lolo: { cooldownSeconds: 300 } },
    });
    expect(saved).not.toHaveProperty('password');
  });

  it('shows basis points as a percentage and refuses invalid documents with the reasons', async () => {
    setup('admin', () => ({
      status: 'invalid',
      issues: [{ path: 'tools.knife.successBp', message: 'باید حداکثر 10000 باشد.' }],
    }));
    renderPanel('/economy');
    const bp = await screen.findByLabelText('احتمال موفقیت چاقو');
    expect(screen.getByText(/= ۶۰٪/)).toBeTruthy();
    fireEvent.change(bp, { target: { value: '20000' } });
    expect(bp.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'بررسی و ثبت' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('باید حداکثر 10000 باشد.');
    expect(screen.getByRole('button', { name: 'ثبت نسخهٔ تازه' })).toHaveProperty('disabled', true);
  });

  it('asks the owner for the password before saving an owner rule', async () => {
    const fake = setup('owner', () => ({
      status: 'ok',
      baseVersionId: 7,
      changes: [change('lolo.cooldownSeconds', 'fixed', 300, 240)],
      needsOwner: true,
    }));
    let saved: Record<string, unknown> = {};
    fake.routes['POST /api/config'] = (init) => {
      saved = JSON.parse(init.body as string) as Record<string, unknown>;
      return saved.password === 'right'
        ? { status: 200, body: { versionId: 8, changes: 1 } }
        : failure(403, 'wrong_password', 'رمز درست نیست.');
    };
    renderPanel('/economy');
    fireEvent.change(await screen.findByLabelText('زمان انتظار لولو'), {
      target: { value: '240' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'بررسی و ثبت' }));
    expect(await screen.findByText(/رمزتان را دوباره وارد کنید/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/توضیح تغییر/), { target: { value: 'سریع‌تر' } });
    const confirm = screen.getByRole('button', { name: 'ثبت نسخهٔ تازه' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('رمز شما'), { target: { value: 'wrong' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toBe('رمز درست نیست.');
    fireEvent.change(screen.getByLabelText('رمز شما'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نسخهٔ تازه' }));
    expect(await screen.findByText(/نسخهٔ ۸/)).toBeTruthy();
    expect(saved.password).toBe('right');
  });

  it('lists versions, shows their changes and rolls back with a note', async () => {
    const fake = installFakeApi(sessionFor({ role: 'admin' }));
    fake.routes['GET /api/config/versions'] = () => ({
      status: 200,
      body: [
        {
          id: 8,
          source: 'panel',
          note: 'ارزان',
          effectiveFrom: '2026-10-14T09:00:00Z',
          createdBy: 'helper',
          ownerApprovedBy: null,
          changeCount: 1,
          ownerRulesChanged: false,
          current: true,
        },
        {
          id: 1,
          source: 'default',
          note: 'v1',
          effectiveFrom: '1970-01-01T00:00:00Z',
          createdBy: null,
          ownerApprovedBy: null,
          changeCount: 0,
          ownerRulesChanged: false,
          current: false,
        },
      ],
    });
    fake.routes['GET /api/config/versions/8'] = () => ({
      status: 200,
      body: {
        id: 8,
        source: 'panel',
        note: 'ارزان',
        effectiveFrom: '2026-10-14T09:00:00Z',
        createdBy: 'helper',
        ownerApprovedBy: null,
        changes: [change('tools.knife.price', 'suggested', 500, 450)],
      },
    });
    let body: unknown;
    fake.routes['POST /api/config/versions/1/rollback'] = (init) => {
      body = JSON.parse(init.body as string);
      return { status: 200, body: { versionId: 9, changes: 1 } };
    };
    renderPanel('/economy?tab=history');
    expect(await screen.findByText('نسخهٔ ۸')).toBeTruthy();
    expect(screen.getByText('فعلی')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'دیدن تغییرها' }));
    expect(await screen.findByText('tools.knife.price')).toBeTruthy();

    const row = screen.getByText('نسخهٔ ۱').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /برگشت به این نسخه/ }));
    fireEvent.change(within(row).getByLabelText('توضیح (اجباری)'), {
      target: { value: 'برگشت به پیش‌فرض' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'برگرداندن' }));
    await waitFor(() => expect(body).toEqual({ note: 'برگشت به پیش‌فرض', baseVersionId: 8 }));
  });
});

describe('draft documents', () => {
  it('write edited values into a copy, by path', () => {
    const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, d: 'x' };
    expect(applyDraft(doc, { 'a.b[1].c': 5, d: null })).toEqual({
      a: { b: [{ c: 1 }, { c: 5 }] },
      d: null,
    });
    expect(doc.a.b[1]!.c).toBe(2);
  });
});
