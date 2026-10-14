import type { AccountView, SessionView } from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import { useId, useState } from 'react';
import { ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format.ts';
import { ROLE_LABEL, deviceLabel } from '../lib/labels.ts';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-start outline-none focus:border-accent aria-[invalid=true]:border-danger sm:max-w-xs';
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'انجام نشد.');

function PasswordForm({ minLength }: { minLength: number }) {
  const client = useQueryClient();
  const ids = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);
  const short = next.length > 0 && next.length < minLength;
  const mismatch = repeat.length > 0 && repeat !== next;
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/account/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
      setRepeat('');
      void client.invalidateQueries({ queryKey: ['account'] });
    },
  });
  const field = (
    key: string,
    label: string,
    value: string,
    set: (v: string) => void,
    autoComplete: string,
    problem: string | null = null,
  ) => (
    <div>
      <label htmlFor={`${ids}-${key}`} className="mb-1 block text-sm text-muted">
        {label}
      </label>
      <input
        id={`${ids}-${key}`}
        type="password"
        dir="ltr"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setDone(false);
        }}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${ids}-${key}-help` : undefined}
        className={input}
      />
      {problem ? (
        <p id={`${ids}-${key}-help`} className="mt-1 text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
  return (
    <section className={card}>
      <h2 className="mb-3 font-bold">تغییر رمز</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        {field('current', 'رمز فعلی', current, setCurrent, 'current-password')}
        {field(
          'next',
          `رمز تازه (دست‌کم ${formatNumber(minLength)} نویسه)`,
          next,
          setNext,
          'new-password',
          short ? `رمز تازه باید دست‌کم ${formatNumber(minLength)} نویسه باشد.` : null,
        )}
        {field(
          'repeat',
          'تکرار رمز تازه',
          repeat,
          setRepeat,
          'new-password',
          mismatch ? 'با رمز تازه یکی نیست.' : null,
        )}
        <p className="text-xs text-muted">
          بعد از تغییر رمز، همهٔ نشست‌های دیگرتان بسته می‌شود و فقط همین مرورگر وارد می‌ماند.
        </p>
        {save.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorText(save.error)}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="text-sm text-ok">
            رمز عوض شد و نشست‌های دیگر بسته شدند.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!current || !next || short || repeat !== next || save.isPending}
          className="rounded-lg bg-accent-strong px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          تغییر رمز
        </button>
      </form>
    </section>
  );
}

function Sessions({ sessions }: { sessions: AccountView['sessions'] }) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['account'] });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/account/sessions/${id}/revoke`, {}),
    onSuccess: refresh,
  });
  const others = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/api/account/sessions/revoke-others', {}),
    onSuccess: refresh,
  });
  const error = revoke.error ?? others.error;
  return (
    <section className={card}>
      <h2 className="mb-3 flex flex-wrap items-center justify-between gap-2 font-bold">
        نشست‌های باز ({formatNumber(sessions.length)})
        {sessions.length > 1 ? (
          <button
            type="button"
            disabled={others.isPending}
            onClick={() => others.mutate()}
            className="rounded-lg border border-line px-3 py-1 text-xs font-normal text-muted hover:border-danger hover:text-danger disabled:opacity-50"
          >
            خروج از همهٔ نشست‌های دیگر
          </button>
        ) : null}
      </h2>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-danger">
          {errorText(error)}
        </p>
      ) : null}
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-raised p-3">
            <MonitorSmartphone aria-hidden className="size-5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {deviceLabel(s.userAgent)}
                {s.current ? (
                  <span className="rounded-full border border-ok/40 px-2 py-0.5 text-xs text-ok">
                    همین مرورگر
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                <span dir="ltr" className="ltr-nums font-mono">
                  {s.ip ?? '—'}
                </span>{' '}
                · ورود {formatDateTime(s.createdAt)} · آخرین فعالیت {formatRelative(s.lastSeenAt)}
              </p>
            </div>
            {!s.current ? (
              <button
                type="button"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(s.id)}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-50"
              >
                <LogOut aria-hidden className="size-3.5" />
                خروج این نشست
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AccountPage({ session }: { session: SessionView }) {
  const query = useQuery({
    queryKey: ['account'],
    queryFn: () => api.get<AccountView>('/api/account'),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const a = query.data;
  return (
    <>
      <PageHeader title="حساب من" />
      <section className={card}>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-bold" dir="ltr">
            {a.user.username}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
            {ROLE_LABEL[a.user.role]}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted">
          حساب از {formatDateTime(a.createdAt)} · نشست بعد از{' '}
          {formatNumber(Math.round(session.idleTimeoutSeconds / 60))} دقیقه بی‌کاری بسته می‌شود.
        </p>
      </section>
      <PasswordForm minLength={a.passwordMinLength} />
      <Sessions sessions={a.sessions} />
    </>
  );
}
