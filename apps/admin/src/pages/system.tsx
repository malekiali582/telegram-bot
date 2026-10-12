import type {
  BackupCreatedView,
  BackupView,
  JobView,
  ServiceInstanceView,
  SessionView,
  SystemView,
} from '@lulu/api/contract';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleX,
  Download,
  FlaskConical,
  HardDriveDownload,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { Empty, ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '../lib/format.ts';
import { SERVICE_LABEL, STATE_LABEL, jobLabel } from '../lib/labels.ts';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className={card}>
      <h2 className="mb-4 flex flex-wrap items-center justify-between gap-2 font-bold">
        {title}
        {aside}
      </h2>
      {children}
    </section>
  );
}

const good = <CircleCheck aria-hidden className="size-4 shrink-0 text-ok" />;
const warn = <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />;
const bad = <CircleX aria-hidden className="size-4 shrink-0 text-danger" />;

function Services({ services, now }: { services: ServiceInstanceView[]; now: Date }) {
  return (
    <Section title="ربات و worker">
      <div className="grid gap-3 sm:grid-cols-2">
        {(['bot', 'worker'] as const).map((name) => {
          const list = services.filter((s) => s.service === name);
          return (
            <div key={name} className="rounded-xl bg-raised p-3">
              <div className="mb-2 font-medium">{SERVICE_LABEL[name]}</div>
              {list.length === 0 ? (
                <p className="text-sm text-muted">در ۲۴ ساعت گذشته گزارشی نداده است.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {list.map((s) => (
                    <li key={s.instance} className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        {s.state === 'online' ? good : s.state === 'stopped' ? warn : bad}
                        {STATE_LABEL[s.state]}
                        <span className="ltr-nums ms-auto truncate font-mono text-xs text-faint">
                          {s.instance}
                        </span>
                      </span>
                      <span className="text-xs text-muted">
                        آخرین گزارش {formatRelative(s.lastSeenAt, now)} · روشن از{' '}
                        {formatDateTime(s.startedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-faint">
        هر پروسه هر ۳۰ ثانیه گزارش می‌دهد. بیش از ۹۰ ثانیه بی‌خبری یعنی «بی‌پاسخ».
      </p>
    </Section>
  );
}

function jobState(job: JobView, now: Date): [ReactNode, string] {
  if (job.running) return [good, 'در حال اجرا'];
  if (job.overdue)
    return [bad, `عقب افتاده (باید ${formatRelative(job.nextRunAt, now)} اجرا می‌شد)`];
  if (job.lastError)
    return [warn, `آخرین اجرا ناموفق (${formatNumber(job.consecutiveFailures)} بار پشت‌سرهم)`];
  return [good, 'سالم'];
}

function Jobs({ jobs, now }: { jobs: JobView[]; now: Date }) {
  return (
    <Section title="کارهای زمان‌بندی‌شده">
      {jobs.length === 0 ? (
        <Empty title="هنوز هیچ کاری ثبت نشده است.">worker با اولین اجرا کارها را ثبت می‌کند.</Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {jobs.map((job) => {
            const [icon, text] = jobState(job, now);
            return (
              <li key={job.name} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{jobLabel(job.name)}</span>
                  <span className="flex items-center gap-1.5 text-sm">
                    {icon}
                    {text}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  آخرین اجرا: {job.lastFinishedAt ? formatRelative(job.lastFinishedAt, now) : '—'} ·
                  اجرای بعدی: {formatRelative(job.nextRunAt, now)}
                </div>
                {job.lastError ? (
                  <p className="mt-1 text-xs break-words whitespace-pre-wrap text-danger">
                    {job.lastError}
                  </p>
                ) : null}
                {job.recentRuns.length ? (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted hover:text-ink">
                      {formatNumber(job.recentRuns.length)} اجرای اخیر
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1">
                      {job.recentRuns.map((r) => (
                        <li key={r.id} className="flex items-center gap-2">
                          {r.status === 'failed' ? bad : r.status === 'running' ? warn : good}
                          {formatDateTime(r.startedAt)}
                          {r.error ? <span className="truncate text-danger">{r.error}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Failures({ failures }: { failures: SystemView['recentFailures'] }) {
  return (
    <Section title="خطاهای ۷ روز گذشته">
      {failures.length === 0 ? (
        <p className="text-sm text-muted">هیچ اجرای ناموفقی ثبت نشده است.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {failures.map((f) => (
            <li key={f.id} className="rounded-lg bg-raised px-3 py-2">
              <div className="flex flex-wrap gap-x-3 text-xs text-muted">
                <span>{jobLabel(f.job)}</span>
                <span>{formatDateTime(f.startedAt)}</span>
              </div>
              <p className="mt-1 break-words whitespace-pre-wrap text-danger">{f.error ?? '—'}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Outbox({ outbox, simulated }: { outbox: SystemView['outbox']; simulated: boolean }) {
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: number) => api.post<{ status: 'pending' }>(`/api/system/outbox/${id}/retry`),
    onSettled: () => client.invalidateQueries({ queryKey: ['system'] }),
  });
  return (
    <Section title="صف ارسال پیام">
      {simulated ? (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          <FlaskConical aria-hidden className="size-4 shrink-0" />
          در حالت توسعه ارسال شبیه‌سازی می‌شود: پیام‌ها «ارسال‌شده» ثبت می‌شوند ولی به هیچ‌جا
          نمی‌روند.
        </p>
      ) : null}
      <div className="mb-4 grid grid-cols-3 gap-2 text-center text-sm">
        <div className="rounded-lg bg-raised p-2">
          <div className="text-lg font-bold">{formatNumber(outbox.pending)}</div>
          <div className="text-xs text-muted">در صف</div>
        </div>
        <div className="rounded-lg bg-raised p-2">
          <div className="text-lg font-bold">{formatNumber(outbox.sent24h)}</div>
          <div className="text-xs text-muted">ارسال در ۲۴ ساعت</div>
        </div>
        <div className="rounded-lg bg-raised p-2">
          <div className={`text-lg font-bold ${outbox.dead ? 'text-danger' : ''}`}>
            {formatNumber(outbox.dead)}
          </div>
          <div className="text-xs text-muted">ناموفق</div>
        </div>
      </div>
      <p className="mb-3 flex items-center gap-2 text-sm">
        {outbox.senderActive ? good : outbox.pending ? bad : warn}
        {outbox.senderActive
          ? 'ارسال‌کننده فعال است.'
          : outbox.pending
            ? 'هیچ worker‌ای پیام نمی‌فرستد؛ پیام‌های صف منتظر می‌مانند.'
            : 'ارسال‌کننده فعال نیست.'}
      </p>
      {outbox.oldestPendingAt ? (
        <p className="mb-3 text-xs text-muted">
          قدیمی‌ترین پیام در صف: {formatDateTime(outbox.oldestPendingAt)}
        </p>
      ) : null}
      {retry.isError ? (
        <p role="alert" className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {retry.error instanceof ApiError ? retry.error.message : 'ارسال دوباره انجام نشد.'}
        </p>
      ) : null}
      {outbox.deadMessages.length === 0 ? (
        <p className="text-sm text-muted">پیام ناموفقی نیست.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {outbox.deadMessages.map((m) => (
            <li key={m.id} className="rounded-xl bg-raised p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <PlatformBadge platform={m.platform} />
                <span className="font-medium">{m.group?.title ?? 'گفت‌وگوی خصوصی'}</span>
                <span className="ltr-nums text-xs text-faint">{m.chatId}</span>
              </div>
              {m.text ? (
                <p className="line-clamp-3 break-words whitespace-pre-wrap text-muted">{m.text}</p>
              ) : null}
              <p className="mt-1 text-xs break-words text-danger">{m.lastError}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-faint">
                <span>{formatDateTime(m.createdAt)}</span>
                <span>{formatNumber(m.attempts)} تلاش</span>
                <button
                  type="button"
                  onClick={() => retry.mutate(m.id)}
                  disabled={retry.isPending}
                  className="ms-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1 text-sm text-ink hover:bg-surface disabled:opacity-50"
                >
                  <RotateCw aria-hidden className="size-3.5" />
                  ارسال دوباره
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Backups() {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ backups: BackupView[]; keep: number }>('/api/system/backups'),
  });
  const create = useMutation({
    mutationFn: (pw: string) =>
      api.post<BackupCreatedView>('/api/system/backups', { password: pw }),
    onSuccess: () => {
      setAsking(false);
      void client.invalidateQueries({ queryKey: ['backups'] });
    },
    onSettled: () => setPassword(''),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate(password);
  };

  return (
    <Section
      title="بکاپ"
      aside={
        !asking ? (
          <button
            type="button"
            onClick={() => {
              create.reset();
              setAsking(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-normal text-white hover:bg-accent-strong/90"
          >
            <HardDriveDownload aria-hidden className="size-4" />
            گرفتن بکاپ
          </button>
        ) : null
      }
    >
      {asking ? (
        <form onSubmit={submit} className="mb-4 rounded-xl bg-raised p-3">
          <label className="block text-sm">
            <span className="mb-1.5 block text-muted">
              برای گرفتن بکاپ، رمز خودتان را دوباره وارد کنید
            </span>
            <input
              type="password"
              autoComplete="current-password"
              dir="ltr"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-start outline-none focus:border-accent sm:max-w-xs"
            />
          </label>
          {create.isError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {create.error instanceof ApiError ? create.error.message : 'بکاپ ساخته نشد.'}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={create.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-1.5 text-sm text-white disabled:opacity-60"
            >
              {create.isPending ? (
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
              ) : null}
              ساختن بکاپ
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:bg-surface"
            >
              انصراف
            </button>
          </div>
        </form>
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="mb-4 rounded-lg bg-raised px-3 py-2 text-sm">
          بکاپ ساخته شد ({formatBytes(create.data.bytes)}). کد sha256:{' '}
          <span className="ltr-nums font-mono text-xs break-all text-muted">
            {create.data.sha256}
          </span>
        </p>
      ) : null}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.backups.length === 0 ? (
        <p className="text-sm text-muted">هنوز بکاپی ساخته نشده است.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {list.data.backups.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center gap-3 py-2">
              <span>{formatDateTime(b.createdAt)}</span>
              <span className="text-muted">{formatBytes(b.bytes)}</span>
              <a
                href={`/api/system/backups/${encodeURIComponent(b.name)}`}
                download={b.name}
                className="ms-auto inline-flex items-center gap-1.5 text-accent hover:underline"
              >
                <Download aria-hidden className="size-4" />
                دانلود
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">
        فقط {formatNumber(list.data?.keep ?? 10)} بکاپ آخر نگه داشته می‌شود. بکاپ همهٔ داده‌های
        بازیکن‌ها را دارد؛ آن را امن نگه دارید. راهنمای بازگردانی: docs/backup.md
      </p>
    </Section>
  );
}

export function SystemPage({ session }: { session: SessionView }) {
  const query = useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemView>('/api/system'),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const s = query.data;
  const now = new Date(s.now);
  return (
    <>
      <PageHeader title="سیستم" />
      <Services services={s.services} now={now} />
      <Jobs jobs={s.jobs} now={now} />
      <Outbox outbox={s.outbox} simulated={session.app.mode === 'dev-panel'} />
      <Failures failures={s.recentFailures} />
      {session.user.role === 'owner' ? <Backups /> : null}
    </>
  );
}
