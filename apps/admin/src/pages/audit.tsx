import type {
  AuditEntryView,
  AuditFiltersView,
  AuditListView,
  SessionView,
} from '@lulu/api/contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Filter } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorState, Loading } from '../components/states.tsx';
import { api } from '../lib/api.ts';
import { formatDateTime, formatNumber } from '../lib/format.ts';
import { asciiDigits, dayToJalali, jalaliToDay } from '../lib/jalali.ts';
import { auditActionLabel, auditTargetLabel } from '../lib/labels.ts';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent aria-[invalid=true]:border-danger';

const KEYS = ['admin', 'action', 'targetType', 'targetId', 'from', 'to', 'q'] as const;
type Key = (typeof KEYS)[number];
type Draft = Record<Key, string>;

function draftFrom(params: URLSearchParams): Draft {
  const d = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as Draft;
  // Dates live in the URL as Gregorian Tehran days and are typed in Jalali.
  for (const k of ['from', 'to'] as const) if (d[k]) d[k] = dayToJalali(d[k]);
  return d;
}

/** Typed filters → URL parameters, or the problems to show under the fields. */
export function auditDraftToParams(d: Draft): {
  params: Record<string, string>;
  errors: Partial<Record<Key, string>>;
} {
  const params: Record<string, string> = {};
  const errors: Partial<Record<Key, string>> = {};
  for (const k of ['admin', 'action', 'targetType'] as const) if (d[k]) params[k] = d[k];
  const targetId = asciiDigits(d.targetId.trim());
  if (targetId) params.targetId = targetId;
  for (const k of ['from', 'to'] as const) {
    if (!d[k].trim()) continue;
    const day = jalaliToDay(d[k]);
    if (day) params[k] = day;
    else errors[k] = 'تاریخ شمسی مثل ۱۴۰۵/۰۷/۲۰ بنویسید.';
  }
  if (params.from && params.to && params.from > params.to) {
    errors.to = '«تا» نباید پیش از «از» باشد.';
  }
  if (d.q.trim()) params.q = d.q.trim();
  return { params, errors };
}

function targetLink(e: AuditEntryView, owner: boolean): string | null {
  const id = e.targetId;
  switch (e.targetType) {
    case 'user':
      return id ? `/players/${id}` : null;
    case 'group':
      return id ? `/groups/${id}` : null;
    case 'admin_user':
      return owner ? '/admins' : null;
    case 'ghost_batch':
      return '/ghosts';
    case 'announcement':
      return '/announcements';
    case 'config_version':
      return '/economy?tab=history';
    case 'group_migration':
      return '/groups/migrations';
    case 'outbox':
      return '/system';
    case 'transactions':
      return '/transactions';
    default:
      return null;
  }
}

const detailValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function Entry({
  e,
  owner,
  onTarget,
}: {
  e: AuditEntryView;
  owner: boolean;
  onTarget: (type: string, id: string) => void;
}) {
  const link = targetLink(e, owner);
  const details = Object.entries(e.details);
  const target = e.targetType ? (
    <>
      {auditTargetLabel(e.targetType)}
      {e.targetName ? (
        <>
          {' «'}
          <bdi>{e.targetName}</bdi>
          {'»'}
        </>
      ) : null}
      {e.targetId && !['transactions', 'backup'].includes(e.targetType) ? (
        <>
          {' '}
          <bdi className="ltr-nums font-mono text-xs">#{e.targetId}</bdi>
        </>
      ) : null}
    </>
  ) : null;
  return (
    <li className="rounded-xl bg-raised p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold">{auditActionLabel(e.action)}</span>
        <span className="text-xs text-muted">
          {e.admin ? (
            <span dir="ltr">{e.admin.username}</span>
          ) : e.actor === 'system' ? (
            'سیستم'
          ) : (
            '—'
          )}{' '}
          · {formatDateTime(e.createdAt)}
        </span>
      </div>
      {target ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {link ? (
            <Link to={link} className="break-all text-accent hover:underline">
              {target}
            </Link>
          ) : (
            <span className="break-all">{target}</span>
          )}
          {e.targetType && e.targetId ? (
            <button
              type="button"
              onClick={() => onTarget(e.targetType!, e.targetId!)}
              className="inline-flex items-center gap-1 text-faint hover:text-ink"
            >
              <Filter aria-hidden className="size-3" />
              کارهای دیگر روی همین
            </button>
          ) : null}
        </p>
      ) : null}
      {e.reason ? <p className="mt-1 break-words">دلیل: {e.reason}</p> : null}
      {details.length > 0 || e.requestId ? (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer select-none">جزئیات</summary>
          <dl className="mt-1 space-y-0.5" dir="ltr">
            {details.map(([k, v]) => (
              <div key={k} className="flex gap-2 break-all">
                <dt className="text-faint">{k}</dt>
                <dd className="font-mono">{detailValue(v)}</dd>
              </div>
            ))}
            {e.requestId ? (
              <div className="flex gap-2 break-all">
                <dt className="text-faint">request</dt>
                <dd className="font-mono">{e.requestId}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

export function AuditPage({ session }: { session: SessionView }) {
  const ids = useId();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(params));
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const owner = session.user.role === 'owner';

  const filters = useQuery({
    queryKey: ['audit', 'filters'],
    queryFn: () => api.get<AuditFiltersView>('/api/audit/filters'),
  });
  const search = new URLSearchParams(params);
  const query = useQuery({
    queryKey: ['audit', 'list', search.toString()],
    queryFn: () => api.get<AuditListView>(`/api/audit?${search.toString()}`),
    placeholderData: keepPreviousData,
  });

  const apply = (d: Draft) => {
    const result = auditDraftToParams(d);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    setParams(new URLSearchParams(result.params));
  };
  const set = (k: Key, v: string) => setDraft({ ...draft, [k]: v });
  const select = (k: Key, v: string) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    apply(next);
  };
  const field = (k: Key, label: string, extra: object = {}) => (
    <div>
      <label htmlFor={`${ids}-${k}`} className="mb-1 block text-xs text-muted">
        {label}
      </label>
      <input
        id={`${ids}-${k}`}
        value={draft[k]}
        onChange={(e) => set(k, e.target.value)}
        aria-invalid={Boolean(errors[k])}
        aria-describedby={errors[k] ? `${ids}-${k}-error` : undefined}
        className={input}
        {...extra}
      />
      {errors[k] ? (
        <p id={`${ids}-${k}-error`} className="mt-1 text-xs text-danger">
          {errors[k]}
        </p>
      ) : null}
    </div>
  );

  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const goto = (p: number) => {
    const next = new URLSearchParams(params);
    if (p > 1) next.set('page', String(p));
    else next.delete('page');
    setParams(next);
  };
  const f = filters.data;

  return (
    <>
      <PageHeader title="سابقهٔ کارها" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
        className={`${card} grid gap-3 sm:grid-cols-2 lg:grid-cols-4`}
      >
        <div>
          <label htmlFor={`${ids}-admin`} className="mb-1 block text-xs text-muted">
            چه کسی
          </label>
          <select
            id={`${ids}-admin`}
            value={draft.admin}
            onChange={(e) => select('admin', e.target.value)}
            className={input}
          >
            <option value="">همه</option>
            <option value="system">سیستم</option>
            {f?.admins.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-action`} className="mb-1 block text-xs text-muted">
            نوع کار
          </label>
          <select
            id={`${ids}-action`}
            value={draft.action}
            onChange={(e) => select('action', e.target.value)}
            className={input}
          >
            <option value="">همه</option>
            {f?.actions.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-targetType`} className="mb-1 block text-xs text-muted">
            هدف
          </label>
          <select
            id={`${ids}-targetType`}
            value={draft.targetType}
            onChange={(e) => select('targetType', e.target.value)}
            className={input}
          >
            <option value="">همه</option>
            {f?.targetTypes.map((t) => (
              <option key={t} value={t}>
                {auditTargetLabel(t)}
              </option>
            ))}
          </select>
        </div>
        {field('targetId', 'شناسهٔ هدف', { dir: 'ltr', inputMode: 'numeric' })}
        {field('from', 'از تاریخ (شمسی)', { dir: 'ltr', placeholder: '۱۴۰۵/۰۷/۰۱' })}
        {field('to', 'تا تاریخ (شمسی)', { dir: 'ltr', placeholder: '۱۴۰۵/۰۷/۳۰' })}
        {field('q', 'جست‌وجو در دلیل، جزئیات و شناسهٔ درخواست')}
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded-lg bg-accent-strong px-4 py-2 text-sm text-white"
          >
            اعمال
          </button>
          <button
            type="button"
            onClick={() => {
              const empty = draftFrom(new URLSearchParams());
              setDraft(empty);
              setErrors({});
              setParams(new URLSearchParams());
            }}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted"
          >
            پاک کردن
          </button>
        </div>
      </form>

      <section className={card}>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">{formatNumber(data!.total)} مورد</p>
            {data!.items.length === 0 ? (
              <p className="text-sm text-muted">موردی با این فیلترها نیست.</p>
            ) : (
              <ul className="space-y-2">
                {data!.items.map((e) => (
                  <Entry
                    key={e.id}
                    e={e}
                    owner={owner}
                    onTarget={(type, id) => {
                      const next = {
                        ...draftFrom(new URLSearchParams()),
                        targetType: type,
                        targetId: id,
                      };
                      setDraft(next);
                      apply(next);
                    }}
                  />
                ))}
              </ul>
            )}
            {pages > 1 ? (
              <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => goto(page - 1)}
                  className="rounded-lg border border-line px-3 py-1 disabled:opacity-40"
                >
                  قبلی
                </button>
                <span className="text-muted">
                  صفحهٔ {formatNumber(page)} از {formatNumber(pages)}
                </span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => goto(page + 1)}
                  className="rounded-lg border border-line px-3 py-1 disabled:opacity-40"
                >
                  بعدی
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
