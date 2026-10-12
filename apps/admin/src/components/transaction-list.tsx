import type { TransactionListView, TransactionView } from '@lulu/api/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { formatDateTime, formatNumber, formatPoints, formatSignedPoints } from '../lib/format.ts';
import { Empty, ErrorState, Loading } from './states.tsx';

/** Query parameters understood by GET /api/transactions (without the cursor). */
export type TransactionParams = Record<string, string>;

const ACCOUNT_LABEL: Record<TransactionView['entries'][number]['account'], string> = {
  cash: 'نقد',
  treasury: 'گنجینه',
  blood_bank: 'بانک خون',
  system: 'سیستم',
};

function Entries({ t }: { t: TransactionView }) {
  if (t.entries.length === 0) {
    return <p className="text-xs text-faint">بدون جابه‌جایی پول (فقط ثبت رویداد).</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {t.entries.map((e, i) => (
        <li key={i} className="flex justify-between gap-3">
          <span className="text-muted">
            {ACCOUNT_LABEL[e.account]}
            {e.userId !== null ? ` بازیکن ${formatNumber(e.userId)}` : ''}
            {e.groupId !== null ? ` گروه ${formatNumber(e.groupId)}` : ''}
            {e.systemCode ? <span className="ltr-nums ms-1 font-mono">{e.systemCode}</span> : null}
          </span>
          <span className={e.amount.startsWith('-') ? 'text-danger' : 'text-ok'}>
            {formatSignedPoints(e.amount)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Row({ t, showDelta }: { t: TransactionView; showDelta: boolean }) {
  return (
    <li className="rounded-xl bg-raised p-3 text-sm md:grid md:grid-cols-[11rem_1fr_9rem] md:items-start md:gap-4">
      <div className="text-xs text-muted md:text-sm">{formatDateTime(t.effectiveAt)}</div>
      <div className="mt-1 min-w-0 md:mt-0">
        <div className="font-medium">{t.kindName}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
          {t.user ? (
            <Link to={`/players/${t.user.id}`} className="text-accent hover:underline">
              {t.user.displayName}
            </Link>
          ) : null}
          {t.group ? <span>{t.group.title}</span> : null}
          {t.admin ? <span>مدیر: {t.admin.username}</span> : null}
        </div>
        {t.reason ? (
          <p className="mt-1 text-xs break-words whitespace-pre-wrap">دلیل: {t.reason}</p>
        ) : null}
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-faint hover:text-muted">
            ردیف‌های دفتر حساب
          </summary>
          <div className="mt-2">
            <Entries t={t} />
          </div>
        </details>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 md:mt-0 md:block md:text-end">
        <div className="font-bold">{formatPoints(t.amount)}</div>
        {showDelta && t.playerDelta !== null && t.playerDelta !== '0' ? (
          <div className={`text-xs ${t.playerDelta.startsWith('-') ? 'text-danger' : 'text-ok'}`}>
            {formatSignedPoints(t.playerDelta)} برای بازیکن
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Newest first, 50 per page; pages are walked with the API's cursors. */
export function TransactionList({
  params,
  exportLink = true,
}: {
  params: TransactionParams;
  exportLink?: boolean;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const key = new URLSearchParams(params).toString();
  // New filters start again at the first page.
  useEffect(() => setCursors([]), [key]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ['transactions', key, cursor ?? null],
    queryFn: () => {
      const search = new URLSearchParams(params);
      if (cursor) search.set('cursor', cursor);
      return api.get<TransactionListView>(`/api/transactions?${search.toString()}`);
    },
    placeholderData: keepPreviousData,
  });
  const [summary, setSummary] = useState<TransactionListView['summary']>(null);
  useEffect(() => {
    if (query.data?.summary) setSummary(query.data.summary);
  }, [query.data]);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { items, next } = query.data;
  const page = cursors.length + 1;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted">
          {summary
            ? `${formatNumber(summary.count)} تراکنش · جابه‌جایی کل ${formatPoints(summary.amount)} پوینت`
            : null}
        </span>
        {exportLink ? (
          <a
            href={`/api/transactions/export.csv${key ? `?${key}` : ''}`}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-muted hover:bg-raised hover:text-ink"
          >
            <Download aria-hidden className="size-4" />
            خروجی CSV
          </a>
        ) : null}
      </div>
      {items.length === 0 ? (
        <Empty title="تراکنشی با این فیلترها پیدا نشد." />
      ) : (
        <ul className={`flex flex-col gap-2 ${query.isPlaceholderData ? 'opacity-60' : ''}`}>
          {items.map((t) => (
            <Row key={t.id} t={t} showDelta={'userId' in params} />
          ))}
        </ul>
      )}
      {page > 1 || next ? (
        <nav aria-label="صفحه‌ها" className="mt-4 flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setCursors((c) => c.slice(0, -1))}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
          >
            <ChevronRight aria-hidden className="size-4" />
            جدیدتر
          </button>
          <span className="text-muted">صفحهٔ {formatNumber(page)}</span>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && setCursors((c) => [...c, next])}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
          >
            قدیمی‌تر
            <ChevronLeft aria-hidden className="size-4" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
