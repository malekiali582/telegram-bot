import type { DashboardView, FlowView, ServiceState } from '@lulu/api/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Info, RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { BarList, StatTile, TrendChart } from '../components/charts.tsx';
import { ErrorState, Loading } from '../components/states.tsx';
import { api } from '../lib/api.ts';
import {
  formatBp,
  formatDay,
  formatDayLong,
  formatNumber,
  formatPoints,
  formatRelative,
  pointsNumber,
} from '../lib/format.ts';
import { STATE_LABEL, accountLabel } from '../lib/labels.ts';
import { PageHeader } from './placeholder.tsx';

const PERIODS = [
  { key: 'today', label: 'امروز' },
  { key: 'week', label: '۷ روز' },
  { key: 'month', label: '۳۰ روز' },
] as const;
type Period = (typeof PERIODS)[number]['key'];

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardView>('/api/dashboard'),
    refetchInterval: 60_000,
    // A refetch keeps the current numbers on screen instead of flashing a spinner.
    placeholderData: keepPreviousData,
  });
}

function InflationNotice({ inflation }: { inflation: DashboardView['inflation'] }) {
  if (inflation.status === 'warning') {
    const parts = [inflation.day, inflation.week]
      .filter((m) => m.exceeded && m.growthBp !== null)
      .map(
        (m) =>
          `${m === inflation.day ? 'در آخرین روز کامل' : 'در ۷ روز کامل گذشته'} ${formatBp(m.growthBp!)} (آستانه ${formatBp(m.thresholdBp)})`,
      );
    return (
      <div
        role="alert"
        className="mb-6 flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
        <div>
          <p className="font-bold text-warn">هشدار تورم</p>
          <p className="mt-1">پول در گردش زیاد شده است: {parts.join('، ')}.</p>
          <p className="mt-1 text-xs text-muted">
            آستانه‌ها در تنظیمات اقتصاد (بخش «هشدار») قابل تغییرند.
          </p>
        </div>
      </div>
    );
  }
  const growth = (m: DashboardView['inflation']['day']) =>
    m.growthBp === null ? 'سنجیده نشد' : formatBp(m.growthBp);
  return (
    <p className="mb-6 flex items-center gap-2 text-xs text-muted">
      <Info aria-hidden className="size-4 shrink-0" />
      {inflation.status === 'not_enough_data'
        ? `رشد پول در گردش وقتی سنجیده می‌شود که دست‌کم ${formatPoints(inflation.minCirculation)} پوینت در گردش باشد.`
        : `رشد پول در گردش: آخرین روز ${growth(inflation.day)}، ۷ روز ${growth(inflation.week)}؛ زیر آستانهٔ هشدار.`}
    </p>
  );
}

function FlowCharts({ flow }: { flow: FlowView }) {
  const bars = (list: FlowView['produced']) =>
    list.map((x) => ({
      key: x.code,
      label: accountLabel(x.code),
      value: pointsNumber(x.centi),
      display: formatPoints(x.centi),
    }));
  const total = (list: FlowView['produced']) => list.reduce((s, x) => s + BigInt(x.centi), 0n);
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h3 className="mb-4 flex items-baseline justify-between font-bold">
            تولید پوینت
            <span className="text-sm font-normal text-muted">
              {formatPoints(total(flow.produced))}
            </span>
          </h3>
          <BarList items={bars(flow.produced)} series={1} empty="در این بازه پوینتی ساخته نشده." />
        </section>
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h3 className="mb-4 flex items-baseline justify-between font-bold">
            مصرف پوینت
            <span className="text-sm font-normal text-muted">
              {formatPoints(total(flow.consumed))}
            </span>
          </h3>
          <BarList items={bars(flow.consumed)} series={2} empty="در این بازه پوینتی خرج نشده." />
        </section>
      </div>
      <p className="mt-3 text-sm text-muted">
        اصلاح مدیر: <span className="text-ink">{formatPoints(flow.adjustments)}</span>
        {' · '}
        تغییر خالص پول در گردش: <span className="font-bold text-ink">{formatPoints(flow.net)}</span>
      </p>
    </>
  );
}

const stateIcon = (state: ServiceState) =>
  state === 'online' ? (
    <CircleCheck aria-hidden className="size-4 text-ok" />
  ) : state === 'never' ? (
    <Info aria-hidden className="size-4 text-faint" />
  ) : (
    <CircleX aria-hidden className="size-4 text-danger" />
  );

function SystemCard({ system }: { system: DashboardView['system'] }) {
  const row = (label: string, icon: ReactNode, text: string) => (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        {icon}
        {text}
      </span>
    </div>
  );
  const ok = <CircleCheck aria-hidden className="size-4 text-ok" />;
  const bad = <TriangleAlert aria-hidden className="size-4 text-warn" />;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="mb-4 flex items-center justify-between font-bold">
        وضعیت سیستم
        <Link to="/system" className="text-sm font-normal text-accent hover:underline">
          جزئیات
        </Link>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {row('ربات', stateIcon(system.bot), STATE_LABEL[system.bot])}
        {row('worker', stateIcon(system.worker), STATE_LABEL[system.worker])}
        {row(
          'کارهای زمان‌بندی‌شده',
          system.jobsWithProblems ? bad : ok,
          system.jobsWithProblems
            ? `${formatNumber(system.jobsWithProblems)} کار مشکل دارد`
            : 'سالم',
        )}
        {row(
          'صف ارسال',
          system.deadMessages ? bad : ok,
          `${formatNumber(system.pendingMessages)} در صف · ${formatNumber(system.deadMessages)} ناموفق`,
        )}
      </div>
      {system.failedRuns24h ? (
        <p className="mt-3 text-xs text-warn">
          {formatNumber(system.failedRuns24h)} اجرای ناموفق در ۲۴ ساعت گذشته
        </p>
      ) : null}
    </section>
  );
}

export function DashboardPage() {
  const query = useDashboard();
  const [period, setPeriod] = useState<Period>('today');
  const [table, setTable] = useState(false);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  const now = d.circulation.now;

  const points = d.circulation.daily.map((p) => ({
    key: p.date,
    label: formatDay(p.date),
    value: pointsNumber(p.total),
    display: `${formatPoints(p.total)} پوینت`,
    details: [
      ['نقد', formatPoints(p.cash)],
      ['گنجینه', formatPoints(p.treasury)],
      ['بانک خون', formatPoints(p.bloodBank)],
    ] as [string, string][],
  }));

  return (
    <>
      <PageHeader title="داشبورد">
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-raised disabled:opacity-50"
        >
          <RotateCw aria-hidden className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          به‌روز: {formatRelative(new Date(query.dataUpdatedAt))}
        </button>
      </PageHeader>

      <InflationNotice inflation={d.inflation} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="بازیکن فعال امروز"
          value={formatNumber(d.players.activeToday)}
          sub={`۷ روز: ${formatNumber(d.players.active7d)} · ۳۰ روز: ${formatNumber(d.players.active30d)}`}
        />
        <StatTile
          label="بازیکن‌ها"
          value={formatNumber(d.players.total)}
          sub={`مسدود: ${formatNumber(d.players.banned)}`}
        />
        <StatTile
          label="گروه‌ها"
          value={formatNumber(d.groups.total)}
          sub={`با ربات: ${formatNumber(d.groups.withBot)} · فعال امروز: ${formatNumber(d.groups.activeToday)}`}
        />
        <StatTile
          label="پول در گردش (پوینت)"
          value={formatPoints(now.total)}
          sub={[
            `نقد ${formatPoints(now.cash)}`,
            `گنجینه ${formatPoints(now.treasury)}`,
            `بانک خون ${formatPoints(now.bloodBank)}`,
          ]}
        />
      </div>
      <p className="-mt-3 mb-6 text-xs text-faint">
        بازیکن فعال: دست‌کم یک «لولو»ی موفق در آن بازه. روزها به وقت تهران.
      </p>

      <section className="mb-6 rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 flex items-center justify-between gap-3 font-bold">
          پول در گردش، ۳۰ روز گذشته
          <button
            type="button"
            onClick={() => setTable((t) => !t)}
            aria-pressed={table}
            className="rounded-lg border border-line px-3 py-1 text-xs font-normal text-muted hover:bg-raised"
          >
            {table ? 'نمودار' : 'جدول'}
          </button>
        </h2>
        {table ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-muted">
                <tr>
                  {['روز', 'نقد', 'گنجینه', 'بانک خون', 'کل'].map((h) => (
                    <th key={h} className="px-2 py-1.5 text-start font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...d.circulation.daily].reverse().map((p) => (
                  <tr key={p.date} className="border-t border-line">
                    <td className="px-2 py-1.5">{formatDayLong(p.date)}</td>
                    <td className="px-2 py-1.5">{formatPoints(p.cash)}</td>
                    <td className="px-2 py-1.5">{formatPoints(p.treasury)}</td>
                    <td className="px-2 py-1.5">{formatPoints(p.bloodBank)}</td>
                    <td className="px-2 py-1.5 font-medium">{formatPoints(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TrendChart
            points={points}
            label="پول در گردش در ۳۰ روز گذشته؛ برای جزئیات جدول را باز کنید"
          />
        )}
      </section>

      <section className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-bold">تولید و مصرف پوینت</h2>
          <div
            role="radiogroup"
            aria-label="بازه"
            className="inline-flex rounded-lg border border-line p-0.5"
          >
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={period === p.key}
                onClick={() => setPeriod(p.key)}
                className={`rounded-md px-3 py-1 text-sm ${
                  period === p.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <FlowCharts flow={d.flows[period]} />
      </section>

      <SystemCard system={d.system} />
    </>
  );
}
