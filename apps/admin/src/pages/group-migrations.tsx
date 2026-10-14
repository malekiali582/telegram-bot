import type { GroupMigrationItemView, MigrationOverviewView } from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatNumber } from '../lib/format.ts';
import { MigrationLine } from './group.tsx';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';

function ReviewForm({ m }: { m: GroupMigrationItemView }) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/api/groups/migrations/${m.id}/review`, { note: note.trim() }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['group-migrations'] }),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) save.mutate();
      }}
      className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end"
    >
      <label className="block flex-1 text-sm">
        <span className="mb-1 block text-muted">چه کردید یا چه باید بشود؟ (اجباری)</span>
        <input
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>
      <button
        type="submit"
        disabled={!note.trim() || save.isPending}
        className="rounded-lg bg-accent-strong px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        علامت «بررسی شد»
      </button>
      {save.isError ? (
        <p role="alert" className="text-sm text-danger">
          {save.error instanceof ApiError ? save.error.message : 'ثبت نشد.'}
        </p>
      ) : null}
    </form>
  );
}

export function GroupMigrationsPage() {
  const query = useQuery({
    queryKey: ['group-migrations'],
    queryFn: () => api.get<MigrationOverviewView>('/api/groups/migrations'),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const o = query.data;

  return (
    <>
      <Link
        to="/groups"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <ArrowRight aria-hidden className="size-4" />
        گروه‌ها
      </Link>
      <PageHeader title="مهاجرت گروه‌ها و تعارض‌ها" />
      <p className="mb-6 text-sm text-muted">
        وقتی گروهی به supergroup تبدیل می‌شود، همان لولوآباد با آیدی تازه ادامه می‌دهد. اگر آیدی
        تازه از قبل مال گروهی با دادهٔ واقعی باشد، ادغام خودکار انجام نمی‌شود و «تعارض» اینجا ثبت
        می‌شود. ادغام دو گروهِ دارای داده کار دستی و جداست؛ اینجا وضعیت دیده و بررسی ثبت می‌شود.
      </p>

      <section className={card}>
        <h2 className="mb-3 font-bold">
          تعارض‌های بررسی‌نشده ({formatNumber(o.openConflicts.length)})
        </h2>
        {o.openConflicts.length === 0 ? (
          <p className="text-sm text-muted">تعارضی برای بررسی نیست.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {o.openConflicts.map((m) => (
              <li key={m.id}>
                <ul>
                  <MigrationLine m={m} />
                </ul>
                <ReviewForm m={m} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 font-bold">گروه‌هایی که آیدی‌شان عوض شده</h2>
        {o.groupsWithPreviousIds.length === 0 ? (
          <p className="text-sm text-muted">هیچ گروهی آیدی‌اش را عوض نکرده است.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {o.groupsWithPreviousIds.map((g) => (
              <li key={g.groupId} className="rounded-lg bg-raised px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {g.platform ? <PlatformBadge platform={g.platform} /> : null}
                  <Link to={`/groups/${g.groupId}`} className="text-accent hover:underline">
                    {g.title}
                  </Link>
                  {g.previous.length > 1 ? (
                    <span className="rounded-full border border-warn/40 px-2 py-0.5 text-xs text-warn">
                      {formatNumber(g.previous.length)} آیدی قدیمی
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-muted">
                  فعلی: <span className="ltr-nums font-mono">{g.chatId ?? '—'}</span> · قدیمی:{' '}
                  {g.previous.map((p, i) => (
                    <span key={p.chatId}>
                      {i ? '، ' : ''}
                      <span className="ltr-nums font-mono">{p.chatId}</span> (تا{' '}
                      {formatDateTime(p.replacedAt)})
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 font-bold">همهٔ مهاجرت‌های ثبت‌شده</h2>
        {o.recent.length === 0 ? (
          <p className="text-sm text-muted">
            هنوز مهاجرتی ثبت نشده است. مهاجرت‌های پیش از این نسخه فقط در «آیدی قدیمی» بالا دیده
            می‌شوند.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {o.recent.map((m) => (
              <MigrationLine key={m.id} m={m} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
