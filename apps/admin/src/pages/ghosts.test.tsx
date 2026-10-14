// @vitest-environment jsdom
import type { GhostBatchDetailView, GhostBatchView, GhostOverviewView } from '@lulu/api/contract';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeApi } from '../testing.tsx';
import { failure, installFakeApi, renderPanel, sessionFor } from '../testing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const batch = (over: Partial<GhostBatchView>): GhostBatchView => ({
  id: 1,
  batchId: 'b-1',
  activeDate: '2026-10-14',
  status: 'active',
  isSample: false,
  source: 'panel',
  importedAt: '2026-10-13T10:00:00Z',
  importedBy: 'helper',
  activatedAt: '2026-10-13T20:30:00Z',
  retiredAt: null,
  encounters: 4,
  heard: 3,
  ...over,
});

function overview(over: Partial<GhostOverviewView> = {}): GhostOverviewView {
  return {
    today: '2026-10-14',
    limits: { batchSize: 5, maxStoryLength: 3500, decidedBy: 'telegram' },
    lookaheadDays: 3,
    missingDates: ['2026-10-16', '2026-10-17'],
    warning: null,
    active: batch({}),
    upcoming: [
      batch({
        id: 2,
        batchId: 'b-2',
        activeDate: '2026-10-15',
        status: 'scheduled',
        encounters: 0,
      }),
    ],
    past: [batch({ id: 3, batchId: 'b-3', activeDate: '2026-10-13', status: 'retired' })],
    pastTotal: 1,
    ...over,
  };
}

function setup(o = overview()): FakeApi {
  const fake = installFakeApi(sessionFor({ role: 'admin', username: 'helper' }));
  fake.routes['GET /api/ghosts'] = () => ({ status: 200, body: o });
  return fake;
}

describe('ghost content page', () => {
  it('warns about missing content and lists live, waiting and past batches', async () => {
    setup(overview({ warning: 'stale_batch', active: batch({ activeDate: '2026-10-13' }) }));
    renderPanel('/ghosts');
    const warning = (await screen.findByText('محتوای روح کم است')).parentElement!;
    expect(warning.textContent).toContain('بستهٔ امروز نرسیده');
    expect(warning.textContent).toContain('۲۴ مهر ۱۴۰۵، ۲۵ مهر ۱۴۰۵');
    expect(screen.getByText('در صف (۱)')).toBeTruthy();
    expect(screen.getAllByText('در صف').length).toBeGreaterThan(0);
    expect(screen.getByText('گذشته (۱)')).toBeTruthy();
    expect(screen.getAllByText(/۴ روح پیدا شد · ۳ «شنیدم»/)).toHaveLength(2); // live and past
  });

  it('shows a batch’s texts as plain text, untrusted markup included', async () => {
    const fake = setup();
    const detail: GhostBatchDetailView = {
      batch: batch({}),
      stories: [1, 2, 3, 4, 5].map((n) => ({
        position: n,
        storyKey: `s${n}`,
        text: n === 1 ? '<img src=x onerror=alert(1)>' : `متن ${n}`,
        encounters: n,
        heard: 0,
      })),
      cancellation: null,
    };
    fake.routes['GET /api/ghosts/1'] = () => ({ status: 200, body: detail });
    const { container } = renderPanel('/ghosts');
    const live = (await screen.findByText('بستهٔ فعال')).closest('section')!;
    fireEvent.click(within(live).getByRole('button', { name: /دیدن متن‌ها/ }));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(within(live).getByText('متن ۵')).toBeTruthy();
    expect(within(live).getByText('۳ بار پیدا شد · ۰ «شنیدم»')).toBeTruthy();
  });

  it('adds a batch from five texts and a Jalali date, showing server reasons per text', async () => {
    const fake = setup();
    const sent: unknown[] = [];
    fake.routes['POST /api/ghosts'] = (init) => {
      const body = JSON.parse(init.body as string) as { texts: string[] };
      sent.push(body);
      return body.texts[1] === body.texts[0]
        ? {
            status: 200,
            body: {
              status: 'invalid',
              activeDate: null,
              texts: [null, 'همان متن ۱ است.', null, null, null],
              form: null,
            },
          }
        : {
            status: 200,
            body: {
              status: 'imported',
              id: 9,
              batchId: 'p',
              activeDate: '2026-10-16',
              live: false,
            },
          };
    };
    renderPanel('/ghosts');
    const date = await screen.findByLabelText('تاریخ فعال‌شدن (شمسی)');
    expect((date as HTMLInputElement).value).toBe('۱۴۰۵/۰۷/۲۴'); // first night without content
    expect(screen.getByText(/از نیمه‌شب ۲۴ مهر ۱۴۰۵ فعال می‌شود/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'ثبت بسته' });
    expect(submit).toHaveProperty('disabled', true);

    for (const n of [1, 2, 3, 4, 5]) {
      fireEvent.change(screen.getByLabelText(`متن ${new Intl.NumberFormat('fa-IR').format(n)}`), {
        target: { value: n === 2 ? 'روح اول' : n === 1 ? 'روح اول' : `روح ${n}` },
      });
    }
    expect(screen.getAllByText('۷ / ۳٬۵۰۰')).toHaveLength(2);
    expect(screen.getAllByText('۵ / ۳٬۵۰۰')).toHaveLength(3); // «روح 3» …
    fireEvent.click(submit);
    expect(await screen.findByText('همان متن ۱ است.')).toBeTruthy();
    expect(screen.getByLabelText('متن ۲').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByLabelText('متن ۲'), { target: { value: 'روح دوم' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت بسته' }));
    expect(await screen.findByText('بسته برای شب ۲۴ مهر ۱۴۰۵ ثبت شد.')).toBeTruthy();
    expect(sent.at(-1)).toEqual({
      activeDate: '2026-10-16',
      texts: ['روح اول', 'روح دوم', 'روح 3', 'روح 4', 'روح 5'],
    });
  });

  it('refuses a past or malformed date before sending, and warns that today replaces the live batch', async () => {
    setup();
    renderPanel('/ghosts');
    const date = await screen.findByLabelText('تاریخ فعال‌شدن (شمسی)');
    fireEvent.change(date, { target: { value: '1405/07/21' } });
    expect(screen.getByText('تاریخ گذشته است.')).toBeTruthy();
    fireEvent.change(date, { target: { value: '1405/13/01' } });
    expect(screen.getByText(/تاریخ شمسی درست نیست/)).toBeTruthy();
    fireEvent.change(date, { target: { value: '۱۴۰۵/۰۷/۲۲' } });
    expect(screen.getByText(/بلافاصله فعال می‌شود/)).toBeTruthy();
  });

  it('cancels a waiting batch with a reason and shows a refusal from the server', async () => {
    const fake = setup();
    let body: unknown;
    fake.routes['POST /api/ghosts/2/cancel'] = (init) => {
      body = JSON.parse(init.body as string);
      return failure(409, 'conflict', 'فقط بستهٔ در صف لغو می‌شود.');
    };
    renderPanel('/ghosts');
    const queue = (await screen.findByText('در صف (۱)')).closest('section')!;
    fireEvent.click(within(queue).getByRole('button', { name: 'لغو' }));
    const confirm = within(queue).getByRole('button', { name: 'لغو بسته' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(within(queue).getByLabelText('دلیل (اجباری)'), {
      target: { value: 'غلط تایپی' },
    });
    fireEvent.click(confirm);
    expect((await within(queue).findByRole('alert')).textContent).toBe(
      'فقط بستهٔ در صف لغو می‌شود.',
    );
    await waitFor(() => expect(body).toEqual({ reason: 'غلط تایپی' }));
  });
});
