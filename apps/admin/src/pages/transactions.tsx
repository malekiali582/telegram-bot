import type { NamedKind } from '@lulu/api/contract';
import { useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { TransactionList } from '../components/transaction-list.tsx';
import { api } from '../lib/api.ts';
import { faDigits } from '../lib/format.ts';
import { addDays, asciiDigits, dayToJalali, jalaliToDay, tehranToday } from '../lib/jalali.ts';
import { PageHeader } from './placeholder.tsx';

const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
const FIELDS = ['userId', 'groupId', 'kind', 'from', 'to', 'min', 'max'] as const;
type Field = (typeof FIELDS)[number];

interface Draft {
  userId: string;
  groupId: string;
  kind: string;
  /** Jalali text as typed. */
  from: string;
  to: string;
  min: string;
  max: string;
}

function draftFrom(params: URLSearchParams): Draft {
  const day = (k: 'from' | 'to') => {
    const v = params.get(k);
    return v ? dayToJalali(v) : '';
  };
  return {
    userId: params.get('userId') ?? '',
    groupId: params.get('groupId') ?? '',
    kind: params.get('kind') ?? '',
    from: day('from'),
    to: day('to'),
    min: params.get('min') ? faDigits(params.get('min')!) : '',
    max: params.get('max') ? faDigits(params.get('max')!) : '',
  };
}

/** Typed draft → API parameters, or the problems to show under the fields. */
export function draftToParams(d: Draft): {
  params: Record<string, string>;
  errors: Partial<Record<Field, string>>;
} {
  const params: Record<string, string> = {};
  const errors: Partial<Record<Field, string>> = {};
  for (const k of ['userId', 'groupId'] as const) {
    const v = asciiDigits(d[k].trim());
    if (!v) continue;
    if (/^\d{1,15}$/.test(v) && Number(v) > 0) params[k] = v;
    else errors[k] = 'شناسه باید عدد باشد.';
  }
  if (d.kind) params.kind = d.kind;
  for (const k of ['from', 'to'] as const) {
    if (!d[k].trim()) continue;
    const day = jalaliToDay(d[k]);
    if (day) params[k] = day;
    else errors[k] = 'تاریخ شمسی مثل ۱۴۰۵/۰۷/۲۰ بنویسید.';
  }
  if (params.from && params.to && params.from > params.to)
    errors.to = '«تا» نباید پیش از «از» باشد.';
  for (const k of ['min', 'max'] as const) {
    const v = asciiDigits(d[k].trim());
    if (!v) continue;
    if (/^\d{1,15}(\.\d{1,2})?$/.test(v)) params[k] = v;
    else errors[k] = 'مبلغ به پوینت، حداکثر دو رقم اعشار.';
  }
  return { params, errors };
}

export function TransactionsPage() {
  const [search, setSearch] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(search));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const kinds = useQuery({
    queryKey: ['transaction-kinds'],
    queryFn: () => api.get<NamedKind[]>('/api/transactions/kinds'),
    staleTime: Infinity,
  });

  const applied: Record<string, string> = {};
  for (const k of FIELDS) {
    const v = search.get(k);
    if (v) applied[k] = v;
  }

  const apply = (d: Draft) => {
    const { params, errors: problems } = draftToParams(d);
    setErrors(problems);
    if (Object.keys(problems).length === 0) setSearch(new URLSearchParams(params));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply(draft);
  };
  const preset = (days: number) => {
    const today = tehranToday();
    const next = {
      ...draft,
      from: dayToJalali(addDays(today, -(days - 1))),
      to: dayToJalali(today),
    };
    setDraft(next);
    apply(next);
  };
  const field = (k: Field, label: string, props: { placeholder?: string; dir?: 'ltr' } = {}) => (
    <div className="min-w-0 text-sm">
      <label>
        <span className="mb-1 block text-muted">{label}</span>
        <input
          value={draft[k]}
          onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          aria-invalid={errors[k] ? true : undefined}
          aria-describedby={errors[k] ? `filter-${k}-error` : undefined}
          className={`${input} ${errors[k] ? 'border-danger' : ''}`}
          {...props}
        />
      </label>
      {/* Outside the label, so the field keeps its name while the error shows. */}
      {errors[k] ? (
        <span id={`filter-${k}-error`} className="mt-1 block text-xs text-danger">
          {errors[k]}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader title="تراکنش‌ها" />
      <form onSubmit={submit} className="mb-6 rounded-2xl border border-line bg-surface p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {field('userId', 'شناسهٔ بازیکن', { dir: 'ltr' })}
          {field('groupId', 'شناسهٔ گروه', { dir: 'ltr' })}
          <label className="col-span-2 block text-sm">
            <span className="mb-1 block text-muted">نوع</span>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              className={input}
            >
              <option value="">همهٔ نوع‌ها</option>
              {kinds.data?.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          {field('from', 'از تاریخ (شمسی)', { placeholder: '۱۴۰۵/۰۷/۰۱' })}
          {field('to', 'تا تاریخ (شمسی)', { placeholder: '۱۴۰۵/۰۷/۲۰' })}
          {field('min', 'مبلغ از (پوینت)')}
          {field('max', 'مبلغ تا (پوینت)')}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <button
            type="submit"
            className="rounded-lg bg-accent-strong px-4 py-1.5 text-white hover:bg-accent-strong/90"
          >
            اعمال فیلتر
          </button>
          <button
            type="button"
            onClick={() => {
              const empty = {
                userId: '',
                groupId: '',
                kind: '',
                from: '',
                to: '',
                min: '',
                max: '',
              };
              setDraft(empty);
              apply(empty);
            }}
            className="rounded-lg border border-line px-4 py-1.5 text-muted hover:bg-raised"
          >
            پاک کردن
          </button>
          <span className="ms-2 text-muted">بازه:</span>
          {[
            [1, 'امروز'],
            [7, '۷ روز'],
            [30, '۳۰ روز'],
          ].map(([days, label]) => (
            <button
              key={days}
              type="button"
              onClick={() => preset(days as number)}
              className="rounded-lg border border-line px-3 py-1 text-muted hover:bg-raised hover:text-ink"
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-faint">
          روزها به وقت تهران و با خود روز «تا». مبلغ یعنی پولی که تراکنش جابه‌جا کرده است.
        </p>
      </form>
      <TransactionList params={applied} />
    </>
  );
}
