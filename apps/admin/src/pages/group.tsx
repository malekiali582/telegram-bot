import type { GroupDetailView, GroupMigrationItemView } from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CirclePause, CirclePlay } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { StatTile } from '../components/charts.tsx';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { ErrorState, Loading } from '../components/states.tsx';
import { TransactionList } from '../components/transaction-list.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatNumber, formatPoints, formatRelative } from '../lib/format.ts';
import { GroupStateBadges } from './groups.tsx';
import { BannedBadge, SampleBadge } from './players.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';

function Card({
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
      <h2 className="mb-3 flex flex-wrap items-center justify-between gap-2 font-bold">
        {title}
        {aside}
      </h2>
      {children}
    </section>
  );
}

export function MigrationLine({ m, groupId }: { m: GroupMigrationItemView; groupId?: number }) {
  return (
    <li className="rounded-lg bg-raised px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={m.platform} />
        {m.status === 'conflict' ? (
          <span className="rounded-full border border-danger/40 px-2 py-0.5 text-xs text-danger">
            تعارض
          </span>
        ) : (
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
            مهاجرت انجام شد
          </span>
        )}
        <span className="text-xs text-muted">{formatDateTime(m.detectedAt)}</span>
      </div>
      <p className="mt-1">
        {m.groupId === groupId ? (
          'این گروه'
        ) : (
          <Link to={`/groups/${m.groupId}`} className="text-accent hover:underline">
            {m.groupTitle}
          </Link>
        )}{' '}
        از <span className="ltr-nums font-mono text-xs">{m.fromChatId}</span> به{' '}
        <span className="ltr-nums font-mono text-xs">{m.toChatId}</span>
      </p>
      {m.otherGroup ? (
        <p className="mt-1 text-xs text-muted">
          آیدی تازه از قبل مال گروه{' '}
          <Link to={`/groups/${m.otherGroup.id}`} className="text-accent hover:underline">
            {m.otherGroup.title}
          </Link>{' '}
          با دادهٔ واقعی است؛ چیزی جابه‌جا نشد.
        </p>
      ) : null}
      {m.absorbedGroupId ? (
        <p className="mt-1 text-xs text-muted">
          گروه بی‌استفادهٔ {formatNumber(m.absorbedGroupId)} که برای آیدی تازه ساخته شده بود در این
          گروه ادغام شد.
        </p>
      ) : null}
      {m.review ? (
        <p className="mt-1 text-xs text-ok">
          بررسی شد: {m.review.adminUsername}، {formatDateTime(m.review.at)}
          {m.review.note ? ` — ${m.review.note}` : ''}
        </p>
      ) : null}
    </li>
  );
}

function DisableForm({
  group,
  onDone,
}: {
  group: GroupDetailView['group'];
  onDone: (msg?: string) => void;
}) {
  const client = useQueryClient();
  const disabling = group.disabledAt === null;
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/groups/${group.id}/disable`, { disabled: disabling, reason: reason.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['group', group.id] });
      void client.invalidateQueries({ queryKey: ['groups'] });
      onDone(disabling ? 'گروه غیرفعال شد.' : 'گروه دوباره فعال شد.');
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) save.mutate();
      }}
      className="mt-3 flex flex-col gap-3 rounded-xl bg-raised p-3"
    >
      <p className="text-sm text-muted">
        {disabling
          ? 'ربات در این گروه هیچ دستوری اجرا نمی‌کند و حداکثر هر ۱۰ دقیقه یک بار می‌گوید که بازی اینجا غیرفعال است. لولوآباد، بانک خون و دادهٔ بازیکن‌ها دست نمی‌خورد. بازیکن‌ها در گروه‌های دیگر و گفت‌وگوی خصوصی بازی می‌کنند.'
          : 'ربات دوباره در این گروه دستورها را اجرا می‌کند.'}
      </p>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">دلیل (اجباری)</span>
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>
      {save.isError ? (
        <p role="alert" className="text-sm text-danger">
          {save.error instanceof ApiError ? save.error.message : 'ثبت نشد.'}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!reason.trim() || save.isPending}
          className={`rounded-lg px-4 py-1.5 text-sm text-white disabled:opacity-50 ${disabling ? 'bg-danger/80' : 'bg-accent-strong'}`}
        >
          {disabling ? 'غیرفعال کن' : 'فعال کن'}
        </button>
        <button
          type="button"
          onClick={() => onDone()}
          className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted"
        >
          انصراف
        </button>
      </div>
    </form>
  );
}

export function GroupPage() {
  const { id = '' } = useParams();
  const groupId = Number(id);
  const valid = Number.isSafeInteger(groupId) && groupId > 0;
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => api.get<GroupDetailView>(`/api/groups/${groupId}`),
    enabled: valid,
  });
  if (!valid) return <ErrorState error={new ApiError('not_found', 'این گروه پیدا نشد.')} />;
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  const c = d.city;

  return (
    <>
      <Link
        to="/groups"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <ArrowRight aria-hidden className="size-4" />
        گروه‌ها
      </Link>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold break-all">{d.group.title}</h1>
          {d.group.isSample ? <SampleBadge /> : null}
          <GroupStateBadges
            botPresent={d.group.botPresent}
            disabled={d.group.disabledAt !== null}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>شناسهٔ داخلی {formatNumber(d.group.id)}</span>
          {d.identity ? (
            <span className="inline-flex items-center gap-1.5">
              <PlatformBadge platform={d.identity.platform} />
              <span className="ltr-nums font-mono text-xs">{d.identity.chatId}</span>
            </span>
          ) : null}
          <span>ربات از {formatDateTime(d.group.botAddedAt)}</span>
          {d.group.botRemovedAt ? (
            <span>حذف ربات: {formatDateTime(d.group.botRemovedAt)}</span>
          ) : null}
        </div>
        {d.group.disabledAt ? (
          <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            غیرفعال از {formatDateTime(d.group.disabledAt)}؛ دلیل: {d.group.disabledReason}
          </p>
        ) : null}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="لولوآباد"
          value={`سطح ${formatNumber(c.level)}`}
          sub={`از ${formatNumber(c.maxLevel)}`}
        />
        <StatTile
          label="جمعیت فعال"
          value={formatNumber(c.population.active)}
          sub={`در ${formatNumber(c.population.windowDays)} روز${c.population.requiredForNext ? ` · سطح بعد ${formatNumber(c.population.requiredForNext)}` : ''}`}
        />
        <StatTile
          label="بانک خون (پوینت)"
          value={formatPoints(c.bloodBank.balance)}
          sub={`سطح ${formatNumber(c.bloodBank.level)} · کل اهدا ${formatPoints(c.bloodBank.donatedTotal)}`}
        />
        <StatTile
          label="شکارگاه"
          value={`سطح ${formatNumber(c.huntingGround.level)}`}
          sub={`امتیاز شکار ${formatNumber(c.huntStore.points)}`}
        />
      </div>

      <section className={card}>
        <h2 className="mb-3 font-bold">کارهای مدیر</h2>
        {notice ? (
          <p role="status" className="mb-3 rounded-lg bg-raised px-3 py-2 text-sm text-ok">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setNotice(null);
            setOpen(!open);
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
        >
          {d.group.disabledAt ? (
            <CirclePlay aria-hidden className="size-4" />
          ) : (
            <CirclePause aria-hidden className="size-4" />
          )}
          {d.group.disabledAt ? 'فعال کردن گروه' : 'غیرفعال کردن گروه'}
        </button>
        {open ? (
          <DisableForm
            group={d.group}
            onDone={(msg) => {
              setOpen(false);
              setNotice(msg ?? null);
            }}
          />
        ) : null}
      </section>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <Card title="ارتقاها و نفرین‌ها">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {c.curses.map((k) => (
              <div key={k.kind} className="contents">
                <dt className="text-muted">{k.name}</dt>
                <dd>
                  سطح {formatNumber(k.level)} (سقف با این بانک خون {formatNumber(k.maxForBank)})
                </dd>
              </div>
            ))}
            <dt className="text-muted">ارتقای بعدی لولوآباد</dt>
            <dd>
              {c.next.city
                ? `${formatPoints(c.next.city.bloodBankCost)} پوینت بانک خون و ${formatNumber(c.next.city.huntPointsCost)} امتیاز شکار`
                : 'به سقف رسیده'}
            </dd>
            <dt className="text-muted">غذاهای اهداشده</dt>
            <dd>
              {c.huntStore.donatedByFood.length
                ? c.huntStore.donatedByFood
                    .map((f) => `${f.name} ×${formatNumber(f.count)}`)
                    .join('، ')
                : 'هیچ'}
            </dd>
          </dl>
        </Card>

        <Card title="ترسناک‌ترین لولوهای گروه">
          {d.leaderboard.length === 0 ? (
            <p className="text-sm text-muted">هنوز کسی در رتبه‌بندی نیست.</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm">
              {d.leaderboard.map((e) => (
                <li key={e.userId} className="flex justify-between gap-3">
                  <span>
                    {formatNumber(e.rank)}.{' '}
                    <Link to={`/players/${e.userId}`} className="text-accent hover:underline">
                      {e.displayName}
                    </Link>{' '}
                    <span className="text-xs text-muted">{e.levelName}</span>
                  </span>
                  <span>{formatPoints(e.points)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card
        title="اعضا"
        aside={
          <span className="text-sm font-normal text-muted">
            {formatNumber(d.members.total)} عضو · {formatNumber(d.members.active)} فعال ·{' '}
            {formatNumber(d.members.left)} رفته
          </span>
        }
      >
        {d.members.list.length === 0 ? (
          <p className="text-sm text-muted">هنوز عضوی ثبت نشده است.</p>
        ) : (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {d.members.list.map((m) => (
              <li key={m.userId} className="rounded-lg bg-raised px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/players/${m.userId}`} className="text-accent hover:underline">
                    {m.displayName}
                  </Link>
                  {m.banned ? <BannedBadge /> : null}
                  {m.status === 'left' ? <span className="text-xs text-faint">رفته</span> : null}
                  {m.active ? <span className="text-xs text-ok">فعال</span> : null}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  آخرین فعالیت موفق: {m.lastSuccessAt ? formatRelative(m.lastSuccessAt) : '—'}
                </div>
              </li>
            ))}
          </ul>
        )}
        {d.members.total + d.members.left > d.members.list.length ? (
          <p className="mt-2 text-xs text-faint">
            فقط {formatNumber(d.members.list.length)} عضو اول نشان داده شده است.
          </p>
        ) : null}
      </Card>

      <Card title="تاریخچهٔ آیدی گفت‌وگو">
        {d.previousChatIds.length === 0 && d.migrations.length === 0 ? (
          <p className="text-sm text-muted">این گروه آیدی‌اش را عوض نکرده است.</p>
        ) : (
          <>
            {d.previousChatIds.length ? (
              <ul className="mb-3 flex flex-col gap-1 text-sm">
                {d.previousChatIds.map((p) => (
                  <li key={p.chatId} className="flex flex-wrap items-center gap-2">
                    <PlatformBadge platform={p.platform} />
                    <span className="ltr-nums font-mono text-xs">{p.chatId}</span>
                    <span className="text-xs text-muted">تا {formatDateTime(p.replacedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="flex flex-col gap-2">
              {d.migrations.map((m) => (
                <MigrationLine key={m.id} m={m} groupId={d.group.id} />
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card
        title="تراکنش‌های گروه"
        aside={
          <Link
            to={`/transactions?groupId=${d.group.id}`}
            className="text-sm font-normal text-accent hover:underline"
          >
            با فیلتر کامل
          </Link>
        }
      >
        <TransactionList params={{ groupId: String(d.group.id) }} />
      </Card>
    </>
  );
}
