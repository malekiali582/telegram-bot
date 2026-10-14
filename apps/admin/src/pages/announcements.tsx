import type {
  AnnouncementDetailView,
  AnnouncementListView,
  AnnouncementRecipientsView,
  AnnouncementTargetRequest,
  AnnouncementView,
  GroupListView,
} from '@lulu/api/contract';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, ChevronDown, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format.ts';
import { PLATFORM_LABEL } from '../lib/labels.ts';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent aria-[invalid=true]:border-danger';
/** Same pace as the server: new announcement messages enter the queue 10 per second. */
const ROWS_PER_SECOND = 10;

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function GroupPicker({
  groupId,
  onPick,
}: {
  groupId: number | null;
  onPick: (id: number | null) => void;
}) {
  const ids = useId();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['groups', 'picker', q],
    queryFn: () => api.get<GroupListView>(`/api/groups?q=${encodeURIComponent(q.trim())}`),
    enabled: q.trim().length > 0 && groupId === null,
    placeholderData: keepPreviousData,
  });
  if (groupId !== null) {
    return (
      <button
        type="button"
        onClick={() => onPick(null)}
        className="text-xs text-accent hover:underline"
      >
        انتخاب گروه دیگر
      </button>
    );
  }
  return (
    <div>
      <label htmlFor={`${ids}-q`} className="mb-1 block text-sm text-muted">
        جست‌وجوی گروه (اسم، شناسه یا آیدی چت)
      </label>
      <input id={`${ids}-q`} value={q} onChange={(e) => setQ(e.target.value)} className={input} />
      {results.data && q.trim() ? (
        results.data.items.length === 0 ? (
          <p className="mt-2 text-sm text-muted">گروهی پیدا نشد.</p>
        ) : (
          <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto">
            {results.data.items.slice(0, 10).map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onPick(g.id)}
                  className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-raised px-3 py-2 text-start text-sm hover:bg-accent-soft"
                >
                  <span className="break-all">{g.title}</span>
                  {g.platform ? <PlatformBadge platform={g.platform} /> : null}
                  {!g.botPresent ? (
                    <span className="text-xs text-danger">ربات بیرون است</span>
                  ) : null}
                  {g.disabledAt ? <span className="text-xs text-warn">غیرفعال</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function RecipientLine({ r, single }: { r: AnnouncementRecipientsView; single: boolean }) {
  const skipped = [
    r.skipped.disabled ? `${formatNumber(r.skipped.disabled)} گروه غیرفعال` : null,
    r.skipped.botRemoved ? `${formatNumber(r.skipped.botRemoved)} گروه که ربات در آن نیست` : null,
    r.skipped.otherPlatform
      ? `${formatNumber(r.skipped.otherPlatform)} گروه روی پلتفرمی که ربات آنجا روشن نیست`
      : null,
  ].filter(Boolean);
  return (
    <div className="rounded-xl bg-raised px-3 py-2 text-sm">
      {r.count === 0 ? (
        <p className="text-danger">
          {single ? 'این گروه پیام را دریافت نمی‌کند' : 'هیچ گروهی پیام را دریافت نمی‌کند'}
          {skipped.length ? ` (${skipped.join('، ')}).` : '.'}
        </p>
      ) : (
        <>
          <p>
            <span className="font-bold">
              {single ? r.sample[0] : `${formatNumber(r.count)} گروه`}
            </span>{' '}
            پیام را دریافت می‌کند
            {!single && r.byPlatform.length > 1
              ? ` (${r.byPlatform.map((p) => `${PLATFORM_LABEL[p.platform]} ${formatNumber(p.count)}`).join('، ')})`
              : ''}
            .
          </p>
          {skipped.length ? (
            <p className="mt-1 text-xs text-muted">بدون این‌ها: {skipped.join('، ')}.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Compose() {
  const client = useQueryClient();
  const ids = useId();
  const [params, setParams] = useSearchParams();
  const preset = Number(params.get('group'));
  const [kind, setKind] = useState<'all_groups' | 'group'>(preset > 0 ? 'group' : 'all_groups');
  const [groupId, setGroupId] = useState<number | null>(preset > 0 ? preset : null);
  const [text, setText] = useState('');
  const [silent, setSilent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const target: AnnouncementTargetRequest | null =
    kind === 'all_groups' ? { kind } : groupId !== null ? { kind, groupId } : null;
  const recipients = useQuery({
    queryKey: ['announcement-recipients', kind, groupId],
    queryFn: () =>
      api.get<AnnouncementRecipientsView>(
        `/api/announcements/recipients${target?.kind === 'group' ? `?groupId=${target.groupId}` : ''}`,
      ),
    enabled: target !== null,
  });
  const r = recipients.data;
  const length = text.trim().length;
  const tooLong = r ? length > r.maxLength : false;
  const ready = target !== null && length > 0 && !tooLong && (r?.count ?? 0) > 0;

  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: number; recipients: number }>('/api/announcements', { target, text, silent }),
    onSuccess: (result) => {
      setDone(`اطلاعیه در صف ارسال به ${formatNumber(result.recipients)} گروه قرار گرفت.`);
      setText('');
      setConfirming(false);
      void client.invalidateQueries({ queryKey: ['announcements'] });
    },
  });
  const pick = (id: number | null) => {
    setGroupId(id);
    setConfirming(false);
    const next = new URLSearchParams(params);
    if (id === null) next.delete('group');
    else next.set('group', String(id));
    setParams(next, { replace: true });
  };

  return (
    <section className={card}>
      <h2 className="mb-3 font-bold">اطلاعیهٔ تازه</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) setConfirming(true);
        }}
        className="space-y-4"
      >
        <fieldset>
          <legend className="mb-2 text-sm text-muted">گیرنده</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['all_groups', 'همهٔ گروه‌ها'],
                ['group', 'یک گروه'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${kind === value ? 'border-accent bg-accent-soft text-ink' : 'border-line text-muted'}`}
              >
                <input
                  type="radio"
                  name={`${ids}-target`}
                  value={value}
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                    setConfirming(false);
                  }}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {kind === 'group' ? <GroupPicker groupId={groupId} onPick={pick} /> : null}
        {target ? (
          recipients.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorText(recipients.error, 'گیرنده‌ها خوانده نشد.')}
            </p>
          ) : r ? (
            <RecipientLine r={r} single={kind === 'group'} />
          ) : (
            <Loading label="شمردن گیرنده‌ها…" />
          )
        ) : null}

        <div>
          <label htmlFor={`${ids}-text`} className="mb-1 block text-sm text-muted">
            متن اطلاعیه
          </label>
          <textarea
            id={`${ids}-text`}
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
              setDone(null);
            }}
            aria-invalid={tooLong}
            aria-describedby={`${ids}-count`}
            className={input}
          />
          <p
            id={`${ids}-count`}
            className={`mt-1 text-xs ${tooLong ? 'text-danger' : 'text-faint'}`}
          >
            {formatNumber(length)} / {formatNumber(r?.maxLength ?? 4096)} · متن ساده؛ قالب‌بندی
            اعمال نمی‌شود.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={silent}
            onChange={(e) => setSilent(e.target.checked)}
            className="size-4 accent-accent-strong"
          />
          بی‌صدا (بدون صدای اعلان)
        </label>

        {length > 0 ? (
          <div>
            <p className="mb-1 text-sm text-muted">پیش‌نمایش</p>
            <div className="max-w-md rounded-2xl rounded-ss-sm bg-raised px-3 py-2 text-sm">
              <p className="break-words whitespace-pre-wrap">{text.trim()}</p>
              {silent ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-faint">
                  <BellOff aria-hidden className="size-3" /> بی‌صدا
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {done ? (
          <p role="status" className="text-sm text-ok">
            {done}
          </p>
        ) : null}
        {confirming && r ? (
          <div className="space-y-3 rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm">
            <p>
              این پیام به {formatNumber(r.count)} گروه فرستاده می‌شود
              {r.count > ROWS_PER_SECOND
                ? ` و ارسالش دست‌کم ${formatDuration(Math.ceil(r.count / ROWS_PER_SECOND))} طول می‌کشد`
                : ''}
              . بعد از ارسال، فقط پیام‌هایی که هنوز در صف‌اند لغو می‌شوند.
            </p>
            {send.isError ? (
              <p role="alert" className="text-danger">
                {errorText(send.error, 'ارسال نشد.')}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={send.isPending}
                onClick={() => send.mutate()}
                className="rounded-lg bg-accent-strong px-4 py-1.5 text-white disabled:opacity-50"
              >
                بله، بفرست
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-line px-4 py-1.5 text-muted"
              >
                انصراف
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            disabled={!ready}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            <Send aria-hidden className="size-4" />
            {r && r.count > 0 ? `ارسال به ${formatNumber(r.count)} گروه` : 'ارسال'}
          </button>
        )}
      </form>
    </section>
  );
}

const DELIVERY: Record<
  AnnouncementDetailView['deliveries'][number]['status'],
  { label: string; tone: string }
> = {
  pending: { label: 'در صف', tone: 'text-accent' },
  sent: { label: 'ارسال شد', tone: 'text-ok' },
  dead: { label: 'ناموفق', tone: 'text-danger' },
  cancelled: { label: 'لغو شد', tone: 'text-muted' },
};

function Deliveries({ id }: { id: number }) {
  const query = useQuery({
    queryKey: ['announcements', 'detail', id],
    queryFn: () => api.get<AnnouncementDetailView>(`/api/announcements/${id}`),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
      {query.data.deliveries.map((d) => (
        <li
          key={`${d.platform}:${d.chatId}`}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-bg px-3 py-1.5 text-sm"
        >
          <PlatformBadge platform={d.platform} />
          {d.groupId !== null ? (
            <Link to={`/groups/${d.groupId}`} className="break-all text-accent hover:underline">
              {d.title}
            </Link>
          ) : (
            <span className="ltr-nums font-mono text-xs">{d.chatId}</span>
          )}
          <span className={`text-xs ${DELIVERY[d.status].tone}`}>{DELIVERY[d.status].label}</span>
          {d.sentAt ? <span className="text-xs text-faint">{formatDateTime(d.sentAt)}</span> : null}
          {d.lastError ? (
            <span className="w-full text-xs break-all text-danger" dir="ltr">
              {d.lastError}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Progress({ counts }: { counts: AnnouncementView['counts'] }) {
  const pct = (n: number) => `${counts.total ? (n / counts.total) * 100 : 0}%`;
  return (
    <div
      role="img"
      aria-label={`${formatNumber(counts.sent)} از ${formatNumber(counts.total)} ارسال شد`}
      className="flex h-1.5 overflow-hidden rounded-full bg-bg"
    >
      <span className="bg-ok" style={{ width: pct(counts.sent) }} />
      <span className="bg-danger" style={{ width: pct(counts.failed) }} />
      <span className="bg-faint" style={{ width: pct(counts.cancelled) }} />
    </div>
  );
}

function AnnouncementItem({ a }: { a: AnnouncementView }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: ['announcements'] });
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/announcements/${a.id}/cancel`, {}),
    onSuccess: () => {
      setConfirmCancel(false);
      refresh();
    },
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/api/announcements/${a.id}/retry`, {}),
    onSuccess: refresh,
  });
  const c = a.counts;
  const chips = [
    c.pending ? { n: c.pending, label: 'در صف', tone: 'text-accent' } : null,
    { n: c.sent, label: 'ارسال‌شده', tone: 'text-ok' },
    c.failed ? { n: c.failed, label: 'ناموفق', tone: 'text-danger' } : null,
    c.cancelled ? { n: c.cancelled, label: 'لغوشده', tone: 'text-muted' } : null,
  ].filter((x) => x !== null);
  const error = cancel.error ?? retry.error;
  return (
    <li className="rounded-xl bg-raised p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-bold text-ink">
          {a.group ? (
            <Link to={`/groups/${a.group.id}`} className="break-all hover:underline">
              {a.group.title}
            </Link>
          ) : (
            'همهٔ گروه‌ها'
          )}
        </span>
        <span>
          {a.createdBy ?? '—'} · {formatDateTime(a.createdAt)}
        </span>
        {a.silent ? (
          <span className="inline-flex items-center gap-1">
            <BellOff aria-hidden className="size-3" /> بی‌صدا
          </span>
        ) : null}
        {a.cancelledAt ? (
          <span className="text-danger">
            لغو: {a.cancelledBy ?? '—'}، {formatDateTime(a.cancelledAt)}
          </span>
        ) : null}
      </div>
      <p className="mb-3 line-clamp-4 text-sm break-words whitespace-pre-wrap">{a.text}</p>
      <Progress counts={c} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        {chips.map((x) => (
          <span key={x.label} className={x.tone}>
            {formatNumber(x.n)} {x.label}
          </span>
        ))}
        <span className="text-faint">از {formatNumber(c.total)}</span>
        <span className="ms-auto flex flex-wrap gap-2">
          {c.failed > 0 ? (
            <button
              type="button"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
              className="rounded-lg border border-line px-2 py-1 text-muted hover:text-ink disabled:opacity-50"
            >
              ارسال دوبارهٔ ناموفق‌ها
            </button>
          ) : null}
          {c.pending > 0 && !confirmCancel ? (
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="rounded-lg border border-line px-2 py-1 text-muted hover:border-danger hover:text-danger"
            >
              لغو مانده‌ها
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-muted hover:text-ink"
          >
            {open ? 'بستن' : 'گیرنده‌ها'}
            <ChevronDown aria-hidden className={`size-3.5 ${open ? 'rotate-180' : ''}`} />
          </button>
        </span>
      </div>
      {confirmCancel ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-bg p-2 text-sm">
          <span className="flex-1">
            {formatNumber(c.pending)} پیامِ در صف لغو شود؟ پیامی که همین لحظه در حال ارسال است ممکن
            است برسد.
          </span>
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            className="rounded-lg bg-danger/80 px-3 py-1 text-white disabled:opacity-50"
          >
            بله، لغو کن
          </button>
          <button
            type="button"
            onClick={() => setConfirmCancel(false)}
            className="rounded-lg border border-line px-3 py-1 text-muted"
          >
            نه
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorText(error, 'انجام نشد.')}
        </p>
      ) : null}
      {open ? <Deliveries id={a.id} /> : null}
    </li>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['announcements', 'list', page],
    queryFn: () => api.get<AnnouncementListView>(`/api/announcements?page=${page}`),
    placeholderData: keepPreviousData,
    // Follow the delivery while something is still waiting in the queue.
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.counts.pending > 0) ? 5_000 : false),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  return (
    <section className={card}>
      <h2 className="mb-3 font-bold">اطلاعیه‌های فرستاده‌شده</h2>
      {d.items.length === 0 ? (
        <p className="text-sm text-muted">هنوز اطلاعیه‌ای فرستاده نشده است.</p>
      ) : (
        <ul className="space-y-3">
          {d.items.map((a) => (
            <AnnouncementItem key={a.id} a={a} />
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
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
            onClick={() => setPage(page + 1)}
            className="rounded-lg border border-line px-3 py-1 disabled:opacity-40"
          >
            بعدی
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function AnnouncementsPage() {
  return (
    <>
      <PageHeader title="اطلاع‌رسانی" />
      <Compose />
      <History />
    </>
  );
}
