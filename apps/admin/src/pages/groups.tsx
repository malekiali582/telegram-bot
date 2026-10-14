import type { GroupListView } from '@lulu/api/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, GitMerge, Search } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { Empty, ErrorState, Loading } from '../components/states.tsx';
import { api } from '../lib/api.ts';
import { formatNumber, formatPoints, formatRelative } from '../lib/format.ts';
import { PageHeader } from './placeholder.tsx';
import { SampleBadge } from './players.tsx';

const select =
  'rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';

export function GroupStateBadges({
  botPresent,
  disabled,
}: {
  botPresent: boolean;
  disabled: boolean;
}) {
  return (
    <>
      {disabled ? (
        <span className="rounded-full border border-danger/40 px-2 py-0.5 text-xs text-danger">
          غیرفعال
        </span>
      ) : null}
      {!botPresent ? (
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          ربات حذف شده
        </span>
      ) : null}
    </>
  );
}

export function GroupsPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const query = useQuery({
    queryKey: ['groups', params.toString()],
    queryFn: () => api.get<GroupListView>(`/api/groups?${params.toString()}`),
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
      <PageHeader title="گروه‌ها">
        <Link
          to="/groups/migrations"
          className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-raised hover:text-ink"
        >
          <GitMerge aria-hidden className="size-4" />
          تعارض‌های مهاجرت
        </Link>
      </PageHeader>
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
            placeholder="اسم گروه، شناسهٔ داخلی یا آیدی گفت‌وگو (فعلی یا قدیمی)"
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
          aria-label="وضعیت"
          value={params.get('status') ?? ''}
          onChange={(e) => update({ status: e.target.value || null })}
          className={select}
        >
          <option value="">همهٔ گروه‌ها</option>
          <option value="active">فعال</option>
          <option value="disabled">غیرفعال‌شده</option>
          <option value="removed">ربات حذف شده</option>
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
          <option value="members">بیشترین عضو فعال</option>
        </select>
      </form>

      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data!.items.length === 0 ? (
        <Empty title="گروهی پیدا نشد.">جست‌وجو یا فیلترها را تغییر دهید.</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">{formatNumber(data!.total)} گروه</p>
          <ul className={`flex flex-col gap-2 ${query.isPlaceholderData ? 'opacity-60' : ''}`}>
            {data!.items.map((g) => (
              <li key={g.id}>
                <Link
                  to={`/groups/${g.id}`}
                  className="block rounded-xl bg-surface p-3 hover:bg-raised md:grid md:grid-cols-[1fr_8rem_10rem_8rem] md:items-center md:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{g.title}</span>
                      {g.isSample ? <SampleBadge /> : null}
                      <GroupStateBadges
                        botPresent={g.botPresent}
                        disabled={g.disabledAt !== null}
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      {g.platform ? <PlatformBadge platform={g.platform} /> : null}
                      {g.chatId ? <span className="ltr-nums font-mono">{g.chatId}</span> : null}
                      <span>شناسه {formatNumber(g.id)}</span>
                      {g.previousChatIds ? (
                        <span>{formatNumber(g.previousChatIds)} آیدی قدیمی</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 text-sm md:mt-0">
                    لولوآباد سطح {formatNumber(g.cityLevel)}
                  </div>
                  <div className="text-sm">
                    <span className="text-muted">عضو فعال: </span>
                    {formatNumber(g.activeMembers)} از {formatNumber(g.members)}
                    <div className="text-xs text-muted">بانک خون {formatPoints(g.bloodBank)}</div>
                  </div>
                  <div className="text-xs text-muted">
                    {g.lastActivityAt ? `فعال ${formatRelative(g.lastActivityAt)}` : 'بدون فعالیت'}
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
