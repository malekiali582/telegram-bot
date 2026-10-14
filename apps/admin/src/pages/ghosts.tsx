import type {
  AddGhostBatchView,
  GhostBatchDetailView,
  GhostBatchStatus,
  GhostBatchView,
  GhostOverviewView,
} from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleX, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { Empty, ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatDayLong, formatNumber } from '../lib/format.ts';
import { dayToJalali, jalaliToDay } from '../lib/jalali.ts';
import { PLATFORM_LABEL } from '../lib/labels.ts';
import { SampleBadge } from './players.tsx';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent aria-[invalid=true]:border-danger';

const STATUS: Record<GhostBatchStatus, { label: string; tone: string }> = {
  scheduled: { label: 'در صف', tone: 'border-accent/40 text-accent' },
  active: { label: 'فعال', tone: 'border-ok/40 text-ok' },
  retired: { label: 'گذشته', tone: 'border-line text-muted' },
  cancelled: { label: 'لغوشده', tone: 'border-danger/40 text-danger' },
};
const SOURCE: Record<GhostBatchView['source'], string> = {
  file: 'از فایل',
  panel: 'از پنل',
  dev_seed: 'نمونهٔ توسعه',
};

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function StatusBadge({ status }: { status: GhostBatchStatus }) {
  const s = STATUS[status];
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${s.tone}`}>{s.label}</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className="mb-3 font-bold">{title}</h2>
      {children}
    </section>
  );
}

/** Missing content, most urgent first: nothing live, a stale live batch, empty nights ahead. */
function Warnings({ o }: { o: GhostOverviewView }) {
  const lines: string[] = [];
  if (o.warning === 'no_active_batch') {
    lines.push('هیچ بستهٔ فعالی نیست؛ جست‌وجوی روح در گروه‌ها چیزی پیدا نمی‌کند.');
  } else if (o.warning === 'stale_batch' && o.active) {
    lines.push(
      `بستهٔ امروز نرسیده؛ متن‌های ${formatDayLong(o.active.activeDate)} هنوز نشان داده می‌شوند.`,
    );
  }
  if (o.missingDates.length > 0) {
    lines.push(
      `برای ${formatNumber(o.lookaheadDays)} شب آینده، این شب‌ها هنوز بسته ندارند: ${o.missingDates
        .map(formatDayLong)
        .join('، ')}.`,
    );
  }
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
      <div className="space-y-1">
        <p className="font-bold text-warn">محتوای روح کم است</p>
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
    </div>
  );
}

type FieldErrors = { date: string | null; texts: (string | null)[]; form: string | null };
const NO_ERRORS: FieldErrors = { date: null, texts: [], form: null };

function AddBatchForm({ o }: { o: GhostOverviewView }) {
  const client = useQueryClient();
  const ids = useId();
  const { batchSize, maxStoryLength, decidedBy } = o.limits;
  const suggested = o.missingDates[0] ?? null;
  const [date, setDate] = useState(suggested ? dayToJalali(suggested) : '');
  const [texts, setTexts] = useState<string[]>(() => Array<string>(batchSize).fill(''));
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [done, setDone] = useState<string | null>(null);

  const day = jalaliToDay(date);
  const dateProblem =
    date.trim() === ''
      ? null
      : !day
        ? 'تاریخ شمسی درست نیست (مثل ۱۴۰۵/۰۷/۲۴).'
        : day < o.today
          ? 'تاریخ گذشته است.'
          : null;
  const ready = day !== null && !dateProblem && texts.every((t) => t.trim() !== '');

  const save = useMutation({
    mutationFn: () => api.post<AddGhostBatchView>('/api/ghosts', { activeDate: day, texts }),
    onSuccess: (result) => {
      if (result.status === 'invalid') {
        setErrors({ date: result.activeDate, texts: result.texts, form: result.form });
        return;
      }
      setErrors(NO_ERRORS);
      setDone(
        result.status === 'already_imported'
          ? 'همین بسته از قبل ثبت شده بود؛ چیزی تغییر نکرد.'
          : result.live
            ? 'بسته ثبت شد و همین حالا فعال است.'
            : `بسته برای شب ${formatDayLong(result.activeDate)} ثبت شد.`,
      );
      setTexts(Array<string>(batchSize).fill(''));
      setDate('');
      void client.invalidateQueries({ queryKey: ['ghosts'] });
    },
  });

  return (
    <Section title="بستهٔ تازه">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
        className="space-y-4"
      >
        <p className="text-sm text-muted">
          هر بسته دقیقاً {formatNumber(batchSize)} متن دارد و نیمه‌شبِ تاریخش (به وقت تهران) جای
          بستهٔ قبلی را می‌گیرد. بستهٔ ناقص پذیرفته نمی‌شود و بستهٔ فعال را تغییر نمی‌دهد.
        </p>
        <div>
          <label htmlFor={`${ids}-date`} className="mb-1 block text-sm text-muted">
            تاریخ فعال‌شدن (شمسی)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={`${ids}-date`}
              dir="ltr"
              inputMode="numeric"
              placeholder="۱۴۰۵/۰۷/۲۴"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDone(null);
              }}
              aria-invalid={Boolean(dateProblem ?? errors.date)}
              aria-describedby={`${ids}-date-help`}
              className={`${input} max-w-40 text-center placeholder:text-faint`}
            />
            {o.missingDates.slice(0, 4).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDate(dayToJalali(d))}
                className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent hover:text-ink"
              >
                {formatDayLong(d)}
              </button>
            ))}
          </div>
          <p id={`${ids}-date-help`} className="mt-1 text-xs">
            {(dateProblem ?? errors.date) ? (
              <span className="text-danger">{dateProblem ?? errors.date}</span>
            ) : day === o.today ? (
              <span className="text-warn">
                تاریخ امروز است: بسته بلافاصله فعال می‌شود و جای متن‌های امروز را می‌گیرد.
              </span>
            ) : day ? (
              <span className="text-muted">از نیمه‌شب {formatDayLong(day)} فعال می‌شود.</span>
            ) : null}
          </p>
        </div>

        {texts.map((text, i) => {
          const length = text.trim().length;
          const problem =
            errors.texts[i] ?? (length > maxStoryLength ? 'متن بلندتر از حد است.' : null);
          return (
            <div key={i}>
              <label htmlFor={`${ids}-t${i}`} className="mb-1 block text-sm text-muted">
                متن {formatNumber(i + 1)}
              </label>
              <textarea
                id={`${ids}-t${i}`}
                rows={3}
                value={text}
                onChange={(e) => {
                  const next = [...texts];
                  next[i] = e.target.value;
                  setTexts(next);
                  setDone(null);
                }}
                aria-invalid={problem !== null}
                aria-describedby={`${ids}-t${i}-help`}
                className={input}
              />
              <p
                id={`${ids}-t${i}-help`}
                className="mt-1 flex flex-wrap justify-between gap-2 text-xs"
              >
                <span className="text-danger">{problem}</span>
                <span className={length > maxStoryLength ? 'text-danger' : 'text-faint'}>
                  {formatNumber(length)} / {formatNumber(maxStoryLength)}
                </span>
              </p>
            </div>
          );
        })}
        <p className="text-xs text-faint">
          حداکثر طول هر متن را محدودیت پیام {PLATFORM_LABEL[decidedBy]} تعیین می‌کند.
        </p>

        {errors.form ? (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        ) : null}
        {save.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorText(save.error, 'ثبت نشد.')}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="text-sm text-ok">
            {done}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!ready || save.isPending}
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          ثبت بسته
        </button>
      </form>
    </Section>
  );
}

function CancelForm({ batch, onDone }: { batch: GhostBatchView; onDone: () => void }) {
  const client = useQueryClient();
  const ids = useId();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/ghosts/${batch.id}/cancel`, { reason: reason.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['ghosts'] });
      void client.invalidateQueries({ queryKey: ['ghost', batch.id] });
      onDone();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) cancel.mutate();
      }}
      className="mt-3 space-y-3 rounded-xl bg-bg p-3"
    >
      <p className="text-sm text-muted">
        بسته از صف بیرون می‌رود و متن‌هایش هرگز نشان داده نمی‌شوند. بعد می‌توانید برای همین شب بستهٔ
        دیگری ثبت کنید.
      </p>
      <label htmlFor={`${ids}-reason`} className="block text-sm text-muted">
        دلیل (اجباری)
      </label>
      <textarea
        id={`${ids}-reason`}
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className={input}
      />
      {cancel.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(cancel.error, 'لغو نشد.')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!reason.trim() || cancel.isPending}
          className="rounded-lg bg-danger/80 px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          لغو بسته
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted"
        >
          انصراف
        </button>
      </div>
    </form>
  );
}

function BatchTexts({ id }: { id: number }) {
  const query = useQuery({
    queryKey: ['ghost', id],
    queryFn: () => api.get<GhostBatchDetailView>(`/api/ghosts/${id}`),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  return (
    <div className="mt-3 space-y-2">
      {d.cancellation ? (
        <p className="text-xs text-danger">
          لغو: {d.cancellation.by ?? '—'}، {formatDateTime(d.cancellation.at)}
          {d.cancellation.reason ? ` — ${d.cancellation.reason}` : ''}
        </p>
      ) : null}
      <ol className="space-y-2">
        {d.stories.map((s) => (
          <li key={s.position} className="rounded-lg bg-bg px-3 py-2 text-sm">
            <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs text-faint">
              <span>متن {formatNumber(s.position)}</span>
              <span>
                {formatNumber(s.encounters)} بار پیدا شد · {formatNumber(s.heard)} «شنیدم»
              </span>
            </div>
            <p className="break-words whitespace-pre-wrap">{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BatchItem({ batch }: { batch: GhostBatchView }) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  return (
    <li className="rounded-xl bg-raised px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{formatDayLong(batch.activeDate)}</span>
        <StatusBadge status={batch.status} />
        {batch.isSample ? <SampleBadge /> : null}
        <span className="text-xs text-muted">
          {SOURCE[batch.source]}
          {batch.importedBy ? ` · ${batch.importedBy}` : ''} · {formatDateTime(batch.importedAt)}
        </span>
        {batch.status !== 'scheduled' && batch.status !== 'cancelled' ? (
          <span className="text-xs text-muted">
            {formatNumber(batch.encounters)} روح پیدا شد · {formatNumber(batch.heard)} «شنیدم»
          </span>
        ) : null}
        <span className="ms-auto flex gap-2">
          {batch.status === 'scheduled' && !cancelling ? (
            <button
              type="button"
              onClick={() => setCancelling(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger"
            >
              <CircleX aria-hidden className="size-3.5" />
              لغو
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-ink"
          >
            {open ? 'بستن' : 'دیدن متن‌ها'}
            <ChevronDown aria-hidden className={`size-3.5 ${open ? 'rotate-180' : ''}`} />
          </button>
        </span>
      </div>
      <p className="ltr-nums mt-1 font-mono text-xs break-all text-faint" dir="ltr">
        {batch.batchId}
      </p>
      {cancelling ? <CancelForm batch={batch} onDone={() => setCancelling(false)} /> : null}
      {open ? <BatchTexts id={batch.id} /> : null}
    </li>
  );
}

function BatchList({ items, empty }: { items: GhostBatchView[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((b) => (
        <BatchItem key={b.id} batch={b} />
      ))}
    </ul>
  );
}

export function GhostsPage() {
  const query = useQuery({
    queryKey: ['ghosts'],
    queryFn: () => api.get<GhostOverviewView>('/api/ghosts'),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const o = query.data;
  return (
    <>
      <PageHeader title="محتوای روح" />
      <Warnings o={o} />
      <Section title="بستهٔ فعال">
        {o.active ? (
          <ul>
            <BatchItem batch={o.active} />
          </ul>
        ) : (
          <Empty title="بستهٔ فعالی نیست" />
        )}
      </Section>
      <Section title={`در صف (${formatNumber(o.upcoming.length)})`}>
        <BatchList items={o.upcoming} empty="بسته‌ای در صف نیست." />
      </Section>
      <AddBatchForm o={o} />
      <Section
        title={
          o.pastTotal > o.past.length
            ? `گذشته (${formatNumber(o.past.length)} از ${formatNumber(o.pastTotal)})`
            : `گذشته (${formatNumber(o.past.length)})`
        }
      >
        <BatchList items={o.past} empty="هنوز بستهٔ گذشته‌ای نیست." />
      </Section>
    </>
  );
}
