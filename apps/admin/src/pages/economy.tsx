import type {
  ConfigChangeView,
  ConfigFieldView,
  ConfigFormView,
  ConfigPreviewView,
  ConfigVersionDetailView,
  ConfigVersionView,
  SessionView,
} from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Lock, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { faDigits, formatDateTime, formatNumber } from '../lib/format.ts';
import { asciiDigits } from '../lib/jalali.ts';
import { PageHeader } from './placeholder.tsx';

type Value = number | string | null;
type Draft = Record<string, Value>;

const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';

/** `levels[2].upgradeCost` → ['levels', 2, 'upgradeCost'] (same as the server). */
function segments(path: string): (string | number)[] {
  return path
    .split(/\.|(?=\[)/)
    .map((s) => (s.startsWith('[') ? Number(s.slice(1, -1)) : s))
    .filter((s) => s !== '');
}

/** A copy of the document with the draft values written in. */
export function applyDraft(config: Record<string, unknown>, draft: Draft): Record<string, unknown> {
  const copy = structuredClone(config);
  for (const [path, value] of Object.entries(draft)) {
    const segs = segments(path);
    let node = copy as Record<string | number, unknown>;
    for (const seg of segs.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
    node[segs.at(-1)!] = value;
  }
  return copy;
}

const show = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'number'
      ? formatNumber(v)
      : typeof v === 'string'
        ? v
        : JSON.stringify(v);

export function LabelBadge({ label }: { label: 'fixed' | 'suggested' }) {
  return label === 'fixed' ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/40 px-2 py-0.5 text-xs text-warn">
      <Lock aria-hidden className="size-3" />
      قطعی
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
      پیشنهادی
    </span>
  );
}

const fieldName = (f: ConfigFieldView) =>
  f.context ? `${f.description} ${f.context}` : f.description;

function FieldInput({
  field,
  value,
  canEdit,
  onChange,
}: {
  field: ConfigFieldView;
  value: Value;
  canEdit: boolean;
  onChange: (v: Value) => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  if (field.readOnly) return <span className="text-sm text-muted">{show(value)}</span>;
  if (field.kind === 'choice') {
    return (
      <select
        aria-label={fieldName(field)}
        disabled={!canEdit}
        value={value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className={`${input} sm:w-48`}
      >
        {field.nullable ? <option value="">هیچ</option> : null}
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  const parsed = /^\d{1,14}$/.test(asciiDigits(text.trim()))
    ? Number(asciiDigits(text.trim()))
    : null;
  const outOfRange =
    parsed !== null &&
    ((field.min !== undefined && parsed < field.min) ||
      (field.max !== undefined && parsed > field.max));
  return (
    <div className="sm:w-48">
      <input
        aria-label={fieldName(field)}
        inputMode="numeric"
        dir="ltr"
        disabled={!canEdit}
        value={text}
        aria-invalid={parsed === null || outOfRange ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = asciiDigits(e.target.value.trim());
          if (/^\d{1,14}$/.test(n)) onChange(Number(n));
        }}
        className={`${input} text-start ${parsed === null || outOfRange ? 'border-danger' : ''}`}
      />
      <div className="mt-0.5 text-xs text-faint">
        {field.basisPoints && parsed !== null ? `= ${faDigits((parsed / 100).toString())}٪ · ` : ''}
        {!field.basisPoints && parsed !== null && parsed >= 10_000
          ? `${formatNumber(parsed)} · `
          : ''}
        {field.min !== undefined || field.max !== undefined
          ? `${field.min !== undefined ? `از ${formatNumber(field.min)}` : ''} ${field.max !== undefined && field.max < 1e12 ? `تا ${formatNumber(field.max)}` : ''}`
          : ''}
      </div>
    </div>
  );
}

function ChangeList({ changes }: { changes: ConfigChangeView[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {changes.map((c) => (
        <li key={c.path} className="rounded-lg bg-raised px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <LabelBadge label={c.label} />
            <span>{c.description}</span>
            {c.context ? <span className="text-muted">· {c.context}</span> : null}
          </div>
          <div className="mt-1">
            <span className="text-muted">{show(c.before)}</span> ← <strong>{show(c.after)}</strong>
            <span className="ltr-nums ms-2 font-mono text-xs text-faint">{c.path}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Review({
  form,
  draft,
  session,
  onCancel,
  onSaved,
}: {
  form: ConfigFormView;
  draft: Draft;
  session: SessionView;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const config = useMemo(() => applyDraft(form.config, draft), [form.config, draft]);
  const preview = useQuery({
    queryKey: ['config-preview', JSON.stringify(draft)],
    queryFn: () => api.post<ConfigPreviewView>('/api/config/preview', { config }),
  });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ versionId: number; changes: number }>('/api/config', {
        config,
        note: note.trim(),
        baseVersionId: form.versionId,
        ...(password ? { password } : {}),
      }),
    onSuccess: (r) =>
      onSaved(
        `نسخهٔ ${formatNumber(r.versionId)} با ${formatNumber(r.changes)} تغییر ثبت شد و از همین حالا اجرا می‌شود.`,
      ),
    onError: () => setPassword(''),
  });
  const p = preview.data;
  const ownerOnly = p?.status === 'ok' && p.needsOwner && session.user.role !== 'owner';

  return (
    <section
      className="mb-6 rounded-2xl border border-accent/40 bg-surface p-4"
      aria-labelledby="review-title"
    >
      <h2 id="review-title" className="mb-3 font-bold">
        بررسی پیش از ثبت
      </h2>
      {preview.isPending ? (
        <Loading label="در حال بررسی…" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
      ) : p!.status === 'invalid' ? (
        <div role="alert">
          <p className="mb-2 text-sm text-danger">این مقدارها با هم جور نیستند و ثبت نمی‌شوند:</p>
          <ul className="flex flex-col gap-1 text-sm">
            {p!.issues.map((i) => (
              <li key={i.path + i.message}>
                <span className="ltr-nums font-mono text-xs text-faint">{i.path}</span> —{' '}
                {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <ChangeList changes={p!.changes} />
          {p!.needsOwner ? (
            <p className="mt-3 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              <Lock aria-hidden className="size-4 shrink-0" />
              {ownerOnly
                ? 'این تغییر به قانون‌های قطعی مالک دست می‌زند و فقط مالک می‌تواند آن را ثبت کند.'
                : 'این تغییر به قانون‌های قطعی مالک دست می‌زند؛ برای ثبت، رمزتان را دوباره وارد کنید.'}
            </p>
          ) : null}
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-muted">توضیح تغییر (اجباری، در تاریخچه می‌ماند)</span>
            <textarea
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={input}
            />
          </label>
          {p!.needsOwner && !ownerOnly ? (
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-muted">رمز شما</span>
              <input
                type="password"
                autoComplete="current-password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${input} text-start sm:max-w-xs`}
              />
            </label>
          ) : null}
          {save.isError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {save.error instanceof ApiError ? save.error.message : 'ثبت نشد.'}
            </p>
          ) : null}
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            p?.status !== 'ok' ||
            !note.trim() ||
            ownerOnly ||
            (p.needsOwner && !password) ||
            save.isPending
          }
          onClick={() => save.mutate()}
          className="rounded-lg bg-accent-strong px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          ثبت نسخهٔ تازه
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted"
        >
          برگشت به ویرایش
        </button>
      </div>
    </section>
  );
}

function SettingsTab({ session }: { session: SessionView }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigFormView>('/api/config'),
  });
  const [draft, setDraft] = useState<Draft>({});
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Remounts the inputs after a save or reset so they show the stored values again.
  const [generation, setGeneration] = useState(0);

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const form = query.data;
  const isOwner = session.user.role === 'owner';
  const changed = Object.keys(draft).length;
  const q = search.trim();
  const visible = (f: ConfigFieldView) =>
    (!onlyChanged || f.path in draft) &&
    (!q ||
      f.description.includes(q) ||
      f.context.includes(q) ||
      f.path.toLowerCase().includes(q.toLowerCase()));

  const setValue = (field: ConfigFieldView, value: Value) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === field.value) delete next[field.path];
      else next[field.path] = value;
      return next;
    });
  const reset = () => {
    setDraft({});
    setReviewing(false);
    setGeneration((g) => g + 1);
  };

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        نسخهٔ فعلی {formatNumber(form.versionId)} · از {formatDateTime(form.effectiveFrom)}
        {form.createdBy ? ` · ${form.createdBy}` : ' · پیش‌فرض کد'}
        {form.note ? ` · «${form.note}»` : ''}
      </p>
      <p className="mb-4 text-xs text-faint">
        مقدارهای «قطعی» قانون‌های مالک‌اند و فقط مالک با تکرار رمز تغییرشان می‌دهد. هر ثبت یک نسخهٔ
        تازه می‌سازد که از همان لحظه اجرا می‌شود؛ کارهایی که پیش از آن انجام شده با تنظیمات زمان
        خودشان می‌مانند.
      </p>
      {notice ? (
        <p role="status" className="mb-4 rounded-lg bg-raised px-3 py-2 text-sm text-ok">
          {notice}
        </p>
      ) : null}
      {reviewing && changed > 0 ? (
        <Review
          form={form}
          draft={draft}
          session={session}
          onCancel={() => setReviewing(false)}
          onSaved={(message) => {
            setNotice(message);
            void client.invalidateQueries({ queryKey: ['config'] });
            void client.invalidateQueries({ queryKey: ['config-versions'] });
            reset();
          }}
        />
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">جست‌وجو در تنظیمات</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جست‌وجو: قیمت، شکار، سطح ۳…"
            className={`${input} ps-9`}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          فقط تغییرداده‌ها
        </label>
      </div>

      <div key={generation} className="flex flex-col gap-3 pb-24">
        {form.sections.map((section) => {
          const fields = section.fields.filter(visible);
          if (fields.length === 0) return null;
          const sectionChanged = fields.some((f) => f.path in draft);
          return (
            <details
              key={section.key}
              open={Boolean(q) || onlyChanged || sectionChanged}
              className="rounded-2xl border border-line bg-surface"
            >
              <summary className="cursor-pointer px-4 py-3 font-bold">
                {section.title}
                <span className="ms-2 text-xs font-normal text-faint">
                  {formatNumber(fields.length)} مقدار
                </span>
              </summary>
              <ul className="flex flex-col divide-y divide-line px-4 pb-2">
                {fields.map((f) => {
                  const value = f.path in draft ? draft[f.path]! : f.value;
                  const canEdit = !f.readOnly && (f.label === 'suggested' || isOwner);
                  return (
                    <li
                      key={f.path}
                      className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between ${f.path in draft ? 'bg-accent-soft/40' : ''}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <LabelBadge label={f.label} />
                          <span>{f.description}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {f.context ? `${f.context} · ` : ''}
                          <span className="ltr-nums font-mono">{f.path}</span>
                          {f.label === 'fixed' && !isOwner && !f.readOnly ? ' · فقط مالک' : ''}
                        </div>
                      </div>
                      <FieldInput
                        field={f}
                        value={value}
                        canEdit={canEdit}
                        onChange={(v) => setValue(f, v)}
                      />
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
      </div>

      {changed > 0 && !reviewing ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:ps-64">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <span className="text-sm">{formatNumber(changed)} تغییر ثبت‌نشده</span>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setReviewing(true);
                window.scrollTo?.({ top: 0 });
              }}
              className="ms-auto rounded-lg bg-accent-strong px-4 py-1.5 text-sm text-white"
            >
              بررسی و ثبت
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted"
            >
              دور ریختن تغییرها
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function VersionRow({
  v,
  session,
  baseVersionId,
}: {
  v: ConfigVersionView;
  session: SessionView;
  baseVersionId: number;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const detail = useQuery({
    queryKey: ['config-version', v.id],
    queryFn: () => api.get<ConfigVersionDetailView>(`/api/config/versions/${v.id}`),
    enabled: open,
  });
  const rollback = useMutation({
    mutationFn: () =>
      api.post(`/api/config/versions/${v.id}/rollback`, {
        note: note.trim(),
        baseVersionId,
        ...(password ? { password } : {}),
      }),
    onSuccess: () => {
      setRolling(false);
      void client.invalidateQueries({ queryKey: ['config'] });
      void client.invalidateQueries({ queryKey: ['config-versions'] });
    },
    onError: () => setPassword(''),
  });
  return (
    <li className="rounded-xl bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">نسخهٔ {formatNumber(v.id)}</span>
        {v.current ? (
          <span className="rounded-full border border-ok/40 px-2 py-0.5 text-xs text-ok">فعلی</span>
        ) : null}
        {v.ownerRulesChanged ? <LabelBadge label="fixed" /> : null}
        <span className="text-muted">{formatDateTime(v.effectiveFrom)}</span>
        <span className="text-muted">
          {v.source === 'default' ? 'پیش‌فرض کد' : (v.createdBy ?? '')}
        </span>
        {v.source === 'panel' ? (
          <span className="text-faint">{formatNumber(v.changeCount)} تغییر</span>
        ) : null}
      </div>
      {v.note ? <p className="mt-1">«{v.note}»</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {v.source === 'panel' ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-accent hover:underline"
          >
            {open ? 'بستن تغییرها' : 'دیدن تغییرها'}
          </button>
        ) : null}
        {!v.current ? (
          <button
            type="button"
            onClick={() => setRolling(!rolling)}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            برگشت به این نسخه
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2">
          {detail.isPending ? (
            <Loading />
          ) : detail.isError ? (
            <ErrorState error={detail.error} />
          ) : (
            <ChangeList changes={detail.data.changes} />
          )}
        </div>
      ) : null}
      {rolling ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) rollback.mutate();
          }}
          className="mt-3 flex flex-col gap-2 rounded-lg bg-raised p-3"
        >
          <p className="text-xs text-muted">
            یک نسخهٔ تازه با همین مقدارها ساخته می‌شود؛ تاریخچه عوض نمی‌شود.
            {session.user.role === 'owner'
              ? ' اگر این برگشت به قانون‌های قطعی دست بزند، رمزتان لازم است.'
              : ''}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">توضیح (اجباری)</span>
            <input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              className={input}
            />
          </label>
          {session.user.role === 'owner' ? (
            <label className="block text-sm">
              <span className="mb-1 block text-muted">رمز شما (برای قانون‌های قطعی)</span>
              <input
                type="password"
                dir="ltr"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${input} text-start sm:max-w-xs`}
              />
            </label>
          ) : null}
          {rollback.isError ? (
            <p role="alert" className="text-sm text-danger">
              {rollback.error instanceof ApiError ? rollback.error.message : 'انجام نشد.'}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!note.trim() || rollback.isPending}
            className="self-start rounded-lg bg-accent-strong px-4 py-1.5 text-white disabled:opacity-50"
          >
            برگرداندن
          </button>
        </form>
      ) : null}
    </li>
  );
}

function HistoryTab({ session }: { session: SessionView }) {
  const versions = useQuery({
    queryKey: ['config-versions'],
    queryFn: () => api.get<ConfigVersionView[]>('/api/config/versions'),
  });
  if (versions.isPending) return <Loading />;
  if (versions.isError)
    return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  const current = versions.data.find((v) => v.current);
  return (
    <ul className="flex flex-col gap-2">
      {versions.data.map((v) => (
        <VersionRow key={v.id} v={v} session={session} baseVersionId={current?.id ?? v.id} />
      ))}
    </ul>
  );
}

export function EconomyPage({ session }: { session: SessionView }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'settings';
  const tabButton = (key: 'settings' | 'history', label: string, icon: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => setParams(key === 'history' ? { tab: 'history' } : {})}
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ${tab === key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <>
      <PageHeader title="تنظیمات اقتصاد">
        <div role="tablist" className="inline-flex rounded-lg border border-line p-0.5">
          {tabButton('settings', 'مقدارها', <SlidersHorizontal aria-hidden className="size-4" />)}
          {tabButton('history', 'تاریخچهٔ نسخه‌ها', <History aria-hidden className="size-4" />)}
        </div>
      </PageHeader>
      {tab === 'history' ? <HistoryTab session={session} /> : <SettingsTab session={session} />}
    </>
  );
}
