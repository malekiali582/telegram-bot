import type { PlayerListView } from '@lulu/api/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { Empty, ErrorState, Loading } from '../components/states.tsx';
import { api } from '../lib/api.ts';
import { formatNumber, formatPoints, formatRelative } from '../lib/format.ts';
import { PageHeader } from './placeholder.tsx';

const select =
  'rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';

export function SampleBadge() {
  return (
    <span className="rounded-full border border-warn/40 px-2 py-0.5 text-xs text-warn">نمونه</span>
  );
}

export function BannedBadge() {
  return (
    <span className="rounded-full border border-danger/40 px-2 py-0.5 text-xs text-danger">
      مسدود
    </span>
  );
}

export function PlayersPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = useQuery({
    queryKey: ['players', params.toString()],
    queryFn: () => api.get<PlayerListView>(`/api/players?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update({ q: text.trim() || null });
  };

  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="بازیکن‌ها" />
      <form onSubmit={submit} role="search" className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">جست‌وجو</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اسم، ‎@یوزرنیم، شناسهٔ داخلی یا آیدی پلتفرم"
            className="w-full rounded-lg border border-line bg-bg py-2 ps-9 pe-3 text-sm outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm text-white hover:bg-accent-strong/90"
        >
          جست‌وجو
        </button>
        <select
          aria-label="مسدودی"
          value={params.get('banned') ?? ''}
          onChange={(e) => update({ banned: e.target.value || null })}
          className={select}
        >
          <option value="">همهٔ بازیکن‌ها</option>
          <option value="only">فقط مسدودها</option>
          <option value="exclude">بدون مسدودها</option>
        </select>
        <select
          aria-label="پلتفرم"
          value={params.get('platform') ?? ''}
          onChange={(e) => update({ platform: e.target.value || null })}
          className={select}
        >
          <option value="">همهٔ پلتفرم‌ها</option>
          <option value="telegram">تلگرام</option>
          <option value="rubika">روبیکا</option>
        </select>
        <select
          aria-label="ترتیب"
          value={params.get('sort') ?? 'recent'}
          onChange={(e) => update({ sort: e.target.value === 'recent' ? null : e.target.value })}
          className={select}
        >
          <option value="recent">آخرین فعالیت</option>
          <option value="newest">جدیدترین</option>
          <option value="richest">ثروتمندترین</option>
        </select>
      </form>

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data!.items.length === 0 ? (
        <Empty title="بازیکنی پیدا نشد.">جست‌وجو یا فیلترها را تغییر دهید.</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">{formatNumber(data!.total)} بازیکن</p>
          <ul className={`flex flex-col gap-2 ${query.isPlaceholderData ? 'opacity-60' : ''}`}>
            {data!.items.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/players/${p.id}`}
                  className="block rounded-xl bg-surface p-3 hover:bg-raised md:grid md:grid-cols-[1fr_9rem_9rem_8rem] md:items-center md:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{p.displayName}</span>
                      {p.isSample ? <SampleBadge /> : null}
                      {p.bannedAt ? <BannedBadge /> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      {p.identities.map((i) => (
                        <PlatformBadge key={i.platform} platform={i.platform} />
                      ))}
                      {p.username ? <span className="ltr-nums">@{p.username}</span> : null}
                      <span>شناسه {formatNumber(p.id)}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-sm md:mt-0">
                    <span className="text-muted md:hidden">سطح: </span>
                    {p.levelName}
                  </div>
                  <div className="text-sm">
                    <span className="text-muted">نقد + گنجینه: </span>
                    {formatPoints((BigInt(p.cash) + BigInt(p.treasury)).toString())}
                  </div>
                  <div className="text-xs text-muted">
                    {p.lastActiveAt
                      ? `فعال ${formatRelative(p.lastActiveAt)}`
                      : 'هنوز فعالیتی ندارد'}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {pages > 1 ? (
            <nav
              aria-label="صفحه‌ها"
              className="mt-4 flex items-center justify-between gap-3 text-sm"
            >
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => update({ page: page - 1 > 1 ? String(page - 1) : null })}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
              >
                <ChevronRight aria-hidden className="size-4" />
                قبلی
              </button>
              <span className="text-muted">
                صفحهٔ {formatNumber(page)} از {formatNumber(pages)}
              </span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => update({ page: String(page + 1) })}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
              >
                بعدی
                <ChevronLeft aria-hidden className="size-4" />
              </button>
            </nav>
          ) : null}
        </>
      )}
    </>
  );
}
