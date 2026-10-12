import type {
  AdjustBalanceRequest,
  AdjustBalanceResult,
  PlayerDetailView,
} from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, Coins, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { StatTile } from '../components/charts.tsx';
import { PlatformBadge } from '../components/platform-badge.tsx';
import { ErrorState, Loading } from '../components/states.tsx';
import { TransactionList } from '../components/transaction-list.tsx';
import { ApiError, api } from '../lib/api.ts';
import {
  formatDateTime,
  formatDayLong,
  formatNumber,
  formatPoints,
  formatRelative,
} from '../lib/format.ts';
import { asciiDigits } from '../lib/jalali.ts';
import { BannedBadge, SampleBadge } from './players.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className="mb-3 font-bold">{title}</h2>
      {children}
    </section>
  );
}

const WAIT_LABEL: Record<string, string> = {
  lolo: 'لولو',
  hunt: 'شکار',
  ghost: 'جست‌وجوی روح',
};

/** Typed points («۲۵۰٫۵») → exact centi; null when malformed. */
export function pointsInput(text: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(asciiDigits(text.trim()));
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

const centiText = (centi: bigint) => {
  const abs = centi < 0n ? -centi : centi;
  return `${centi < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

type Done = (message?: string) => void;

function AdjustForm({ player, onDone }: { player: PlayerDetailView; onDone: Done }) {
  const client = useQueryClient();
  const [wallet, setWallet] = useState<'cash' | 'treasury'>('cash');
  const [direction, setDirection] = useState<'give' | 'take'>('give');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  // One key per opened form: a double click or a retried request changes nothing.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const walletName = wallet === 'cash' ? 'نقد' : 'گنجینه';
  const centi = pointsInput(amount);
  const signed = centi === null ? null : direction === 'give' ? centi : -centi;
  const before = BigInt(wallet === 'cash' ? player.cash : player.treasury);
  const after = signed === null ? null : before + signed;
  const problem =
    centi === null || centi === 0n
      ? 'مبلغ را به پوینت بنویسید (حداکثر دو رقم اعشار).'
      : after !== null && after < 0n
        ? 'موجودی منفی نمی‌شود.'
        : reason.trim() === ''
          ? 'نوشتن دلیل الزامی است.'
          : null;

  const save = useMutation({
    mutationFn: (body: AdjustBalanceRequest) =>
      api.post<AdjustBalanceResult>(`/api/players/${player.user.id}/adjust`, body),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['player', player.user.id] });
      void client.invalidateQueries({ queryKey: ['transactions'] });
      onDone(
        result.duplicate || result.balance === null
          ? 'این درخواست قبلاً ثبت شده بود؛ چیزی دوباره ثبت نشد.'
          : `ثبت شد. موجودی تازهٔ ${walletName}: ${formatPoints(result.balance)} پوینت`,
      );
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || signed === null) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    save.mutate({ wallet, amount: centiText(signed), reason: reason.trim(), idempotencyKey });
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 rounded-xl bg-raised p-3">
      <div className="flex flex-wrap gap-4 text-sm">
        <fieldset className="flex gap-3" disabled={confirming}>
          <legend className="sr-only">کیف پول</legend>
          {(['cash', 'treasury'] as const).map((w) => (
            <label key={w} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="wallet"
                checked={wallet === w}
                onChange={() => setWallet(w)}
              />
              {w === 'cash' ? 'نقد' : 'گنجینه'}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex gap-3" disabled={confirming}>
          <legend className="sr-only">جهت</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="direction"
              checked={direction === 'give'}
              onChange={() => setDirection('give')}
            />
            دادن
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="direction"
              checked={direction === 'take'}
              onChange={() => setDirection('take')}
            />
            کم کردن
          </label>
        </fieldset>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">مبلغ (پوینت)</span>
        <input
          inputMode="decimal"
          dir="ltr"
          value={amount}
          disabled={confirming}
          onChange={(e) => setAmount(e.target.value)}
          className={`${input} text-start sm:max-w-48`}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">دلیل (اجباری، در سابقه ثبت می‌شود)</span>
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          disabled={confirming}
          onChange={(e) => setReason(e.target.value)}
          className={input}
        />
      </label>
      {after !== null && centi !== 0n ? (
        <p className="text-sm">
          موجودی {walletName}: {formatPoints(before)} ← <strong>{formatPoints(after)}</strong>
        </p>
      ) : null}
      {confirming ? (
        <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          مطمئنید؟ یک تراکنش جبرانی ثبت می‌شود؛ تاریخچهٔ قبلی تغییر نمی‌کند و پاک نمی‌شود.
        </p>
      ) : problem && (amount || reason) ? (
        <p className="text-xs text-muted">{problem}</p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger">
          {save.error instanceof ApiError ? save.error.message : 'ثبت نشد.'}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={problem !== null || save.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {save.isPending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
          {confirming ? 'تأیید و ثبت' : 'بررسی'}
        </button>
        <button
          type="button"
          onClick={() => (confirming ? setConfirming(false) : onDone())}
          className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:bg-surface"
        >
          {confirming ? 'ویرایش' : 'انصراف'}
        </button>
      </div>
    </form>
  );
}

function BanForm({ player, onDone }: { player: PlayerDetailView; onDone: Done }) {
  const client = useQueryClient();
  const banning = player.user.bannedAt === null;
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/players/${player.user.id}/ban`, { banned: banning, reason: reason.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['player', player.user.id] });
      void client.invalidateQueries({ queryKey: ['players'] });
      onDone(banning ? 'بازیکن مسدود شد.' : 'مسدودی برداشته شد.');
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
        {banning
          ? 'بازیکن مسدود هیچ کاری در بازی نمی‌تواند بکند و در رتبه‌بندی نمی‌آید. داده‌هایش می‌ماند.'
          : 'بازیکن دوباره می‌تواند بازی کند.'}
      </p>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">دلیل (اجباری)</span>
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={input}
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
          className={`rounded-lg px-4 py-1.5 text-sm text-white disabled:opacity-50 ${banning ? 'bg-danger/80' : 'bg-accent-strong'}`}
        >
          {banning ? 'مسدود کن' : 'رفع مسدودی'}
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

export function PlayerPage() {
  const { id = '' } = useParams();
  const userId = Number(id);
  const [open, setOpen] = useState<'adjust' | 'ban' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['player', userId],
    queryFn: () => api.get<PlayerDetailView>(`/api/players/${userId}`),
    enabled: Number.isSafeInteger(userId) && userId > 0,
  });
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return <ErrorState error={new ApiError('not_found', 'این بازیکن پیدا نشد.')} />;
  }
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const p = query.data;
  const finish = (message?: string) => {
    setOpen(null);
    setNotice(message ?? null);
  };

  return (
    <>
      <Link
        to="/players"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <ArrowRight aria-hidden className="size-4" />
        بازیکن‌ها
      </Link>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold break-all">{p.user.displayName}</h1>
          {p.user.isSample ? <SampleBadge /> : null}
          {p.user.bannedAt ? <BannedBadge /> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>شناسهٔ داخلی {formatNumber(p.user.id)}</span>
          {p.user.username ? <span className="ltr-nums">@{p.user.username}</span> : null}
          {p.identities.map((i) => (
            <span key={i.platform} className="inline-flex items-center gap-1.5">
              <PlatformBadge platform={i.platform} />
              <span className="ltr-nums font-mono text-xs">{i.platformUserId}</span>
            </span>
          ))}
          <span>عضو از {formatDateTime(p.user.createdAt)}</span>
        </div>
        {p.user.bannedAt ? (
          <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            مسدود از {formatDateTime(p.user.bannedAt)}؛ دلیل: {p.user.banReason}
          </p>
        ) : null}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="سطح"
          value={p.levelName}
          sub={`${formatNumber(p.level)} از ${formatNumber(p.maxLevel)}${p.nextLevelCost ? ` · ارتقا ${formatPoints(p.nextLevelCost)}` : ''}`}
        />
        <StatTile label="نقد (پوینت)" value={formatPoints(p.cash)} />
        <StatTile label="گنجینه (پوینت)" value={formatPoints(p.treasury)} />
        <StatTile
          label="قبرستان"
          value={p.cemetery ? `سطح ${formatNumber(p.cemetery.level)}` : 'ندارد'}
          sub={p.cemetery ? `${formatPoints(p.cemetery.hourlyIncome)} پوینت در ساعت` : undefined}
        />
      </div>

      <section className={card}>
        <h2 className="mb-3 font-bold">کارهای مدیر</h2>
        {notice ? (
          <p role="status" className="mb-3 rounded-lg bg-raised px-3 py-2 text-sm text-ok">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setOpen(open === 'adjust' ? null : 'adjust');
            }}
            aria-expanded={open === 'adjust'}
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
          >
            <Coins aria-hidden className="size-4" />
            دادن یا کم کردن پوینت
          </button>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setOpen(open === 'ban' ? null : 'ban');
            }}
            aria-expanded={open === 'ban'}
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
          >
            {p.user.bannedAt ? (
              <ShieldCheck aria-hidden className="size-4" />
            ) : (
              <Ban aria-hidden className="size-4" />
            )}
            {p.user.bannedAt ? 'رفع مسدودی' : 'مسدود کردن'}
          </button>
        </div>
        {open === 'adjust' ? <AdjustForm player={p} onDone={finish} /> : null}
        {open === 'ban' ? <BanForm player={p} onDone={finish} /> : null}
      </section>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <Card title="دارایی‌ها">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">ابزارها</dt>
            <dd>
              {p.tools.owned.length ? p.tools.owned.map((t) => t.name).join('، ') : 'ندارد'}
              {p.tools.equipped ? (
                <span className="text-muted"> (در دست: {p.tools.equipped.name})</span>
              ) : null}
            </dd>
            <dt className="text-muted">غذاها</dt>
            <dd>
              {p.inventory.length
                ? p.inventory.map((f) => `${f.name} ×${formatNumber(f.count)}`).join('، ')
                : 'ندارد'}
            </dd>
            <dt className="text-muted">وعده‌های فعال</dt>
            <dd>
              {formatNumber(p.meals.active.length)} از {formatNumber(p.meals.capacity)}
              {p.meals.active.map((m, i) => (
                <div key={i} className="text-xs text-muted">
                  {m.name}: {formatNumber(m.depositsLeft)} واریز {formatPoints(m.deposit)}، تا{' '}
                  {formatRelative(m.expiresAt)}
                </div>
              ))}
            </dd>
            <dt className="text-muted">زمان انتظار</dt>
            <dd>
              {p.waits.length
                ? p.waits
                    .map((w) => `${WAIT_LABEL[w.kind] ?? w.kind} ${formatRelative(w.until)}`)
                    .join('، ')
                : 'آزاد'}
            </dd>
            <dt className="text-muted">روح امروز</dt>
            <dd>
              {formatNumber(p.ghostsToday.found)} از {formatNumber(p.ghostsToday.limit)}
            </dd>
          </dl>
        </Card>

        <Card title="گروه‌ها">
          {p.groups.length === 0 ? (
            <p className="text-sm text-muted">در هیچ گروهی نیست.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {p.groups.map((g) => (
                <li key={g.groupId} className="rounded-lg bg-raised px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {g.platform ? <PlatformBadge platform={g.platform} /> : null}
                    <span className="font-medium">{g.title}</span>
                    {g.status === 'left' ? <span className="text-xs text-faint">رفته</span> : null}
                    {!g.botPresent ? (
                      <span className="text-xs text-faint">ربات حذف شده</span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    استریک: {formatNumber(g.streak)} روز · آخرین فعالیت موفق:{' '}
                    {g.lastSuccessAt ? formatRelative(g.lastSuccessAt) : '—'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="روح‌ها">
          <p className="mb-2 text-sm text-muted">
            پیدا کرده: {formatNumber(p.ghosts.foundTotal)} · «شنیدم»:{' '}
            {formatNumber(p.ghosts.heardTotal)}
          </p>
          {p.ghosts.recent.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {p.ghosts.recent.map((g) => (
                <li key={g.id} className="rounded-lg bg-raised px-3 py-2">
                  <div className="text-xs text-muted">
                    {formatDateTime(g.foundAt)} · {g.groupTitle} ·{' '}
                    {g.heardAt
                      ? 'شنیده شد'
                      : new Date(g.expiresAt) < new Date()
                        ? 'منقضی'
                        : 'منتظر «شنیدم»'}
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap">{g.text}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card title="پاداش‌های استریک اخیر">
          {p.streakRewards.length === 0 ? (
            <p className="text-sm text-muted">هنوز پاداشی نگرفته است.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {p.streakRewards.map((r) => (
                <li key={r.date} className="flex flex-wrap justify-between gap-2">
                  <span className="text-muted">
                    {formatDayLong(r.date)} · {r.groupTitle} · روز {formatNumber(r.streak)}
                  </span>
                  <span>{formatPoints((BigInt(r.personal) + BigInt(r.group)).toString())}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className={card}>
        <h2 className="mb-3 flex flex-wrap items-center justify-between gap-2 font-bold">
          تاریخچهٔ تراکنش‌ها
          <Link
            to={`/transactions?userId=${p.user.id}`}
            className="text-sm font-normal text-accent hover:underline"
          >
            با فیلتر کامل
          </Link>
        </h2>
        <TransactionList params={{ userId: String(p.user.id) }} />
      </section>
    </>
  );
}
