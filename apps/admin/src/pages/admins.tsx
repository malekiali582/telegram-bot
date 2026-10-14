import type { AdminListItemView, AdminRole } from '@lulu/api/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, UserMinus, UserPlus, UserRoundCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { ErrorState, Loading } from '../components/states.tsx';
import { ApiError, api } from '../lib/api.ts';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format.ts';
import { ROLE_LABEL } from '../lib/labels.ts';
import { SESSION_KEY } from '../lib/session.ts';
import { PageHeader } from './placeholder.tsx';

const card = 'mb-6 rounded-2xl border border-line bg-surface p-4';
const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
const button = 'rounded-lg px-4 py-1.5 text-sm disabled:opacity-50';
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'انجام نشد.');

/** A strong random password the owner can hand over (they copy it once). */
export function randomPassword(length = 20): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      {children}
    </label>
  );
}

function OwnPassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="رمز خودتان (برای تأیید)">
      <input
        type="password"
        autoComplete="current-password"
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${input} text-start sm:max-w-xs`}
      />
    </Field>
  );
}

function NewPassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="رمز تازهٔ او (دست‌کم ۱۲ نویسه)">
      <span className="flex flex-wrap gap-2">
        <input
          type="text"
          autoComplete="off"
          dir="ltr"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${input} font-mono text-start sm:max-w-xs`}
        />
        <button
          type="button"
          onClick={() => onChange(randomPassword())}
          className="rounded-lg border border-line px-3 py-1 text-xs text-muted hover:text-ink"
        >
          رمز تصادفی
        </button>
      </span>
    </Field>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['admins'] });
    // My own role may have changed.
    void client.invalidateQueries({ queryKey: SESSION_KEY });
  };
}

function AddAdmin({ onDone }: { onDone: (msg: string) => void }) {
  const refresh = useRefresh();
  const ids = useId();
  const [username, setUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [role, setRole] = useState<AdminRole>('admin');
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => api.post('/api/admins', { username, newPassword, role, password }),
    onSuccess: () => {
      refresh();
      onDone(
        `حساب «${username.trim().toLowerCase()}» ساخته شد. رمز را از راهی امن به او بدهید؛ دوباره نشان داده نمی‌شود.`,
      );
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className={`${card} space-y-3`}
    >
      <h2 className="font-bold">مدیر تازه</h2>
      <Field label="نام کاربری (حروف کوچک انگلیسی، رقم، _ . -)">
        <input
          dir="ltr"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={`${input} text-start sm:max-w-xs`}
        />
      </Field>
      <NewPassword value={newPassword} onChange={setNewPassword} />
      <fieldset>
        <legend className="mb-1 text-sm text-muted">نقش</legend>
        <div className="flex gap-2">
          {(['admin', 'owner'] as const).map((r) => (
            <label
              key={r}
              className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${role === r ? 'border-accent bg-accent-soft' : 'border-line text-muted'}`}
            >
              <input
                type="radio"
                name={`${ids}-role`}
                checked={role === r}
                onChange={() => setRole(r)}
                className="sr-only"
              />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
        {role === 'owner' ? (
          <p className="mt-1 text-xs text-warn">
            مالک همه‌کار می‌کند: مدیران، قانون‌های قطعی و بکاپ.
          </p>
        ) : null}
      </fieldset>
      <OwnPassword value={password} onChange={setPassword} />
      {save.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(save.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!username.trim() || !newPassword || !password || save.isPending}
          className={`${button} bg-accent-strong text-white`}
        >
          ساختن حساب
        </button>
        <button
          type="button"
          onClick={() => onDone('')}
          className={`${button} border border-line text-muted`}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}

type Action = 'role' | 'password' | 'disable' | 'enable';

function ActionForm({
  admin,
  action,
  onDone,
}: {
  admin: AdminListItemView;
  action: Action;
  onDone: (msg?: string) => void;
}) {
  const refresh = useRefresh();
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [reason, setReason] = useState('');
  const otherRole: AdminRole = admin.role === 'owner' ? 'admin' : 'owner';
  const run = useMutation({
    mutationFn: () => {
      switch (action) {
        case 'role':
          return api.post(`/api/admins/${admin.id}/role`, { role: otherRole, password });
        case 'password':
          return api.post(`/api/admins/${admin.id}/password`, { newPassword, password });
        case 'disable':
        case 'enable':
          return api.post(`/api/admins/${admin.id}/disable`, {
            disabled: action === 'disable',
            reason,
            password,
          });
      }
    },
    onSuccess: () => {
      refresh();
      onDone(
        {
          role: `نقش «${admin.username}» ${ROLE_LABEL[otherRole]} شد.`,
          password: `رمز تازهٔ «${admin.username}» ثبت شد و همهٔ نشست‌هایش بسته شد. رمز را از راهی امن به او بدهید.`,
          disable: `«${admin.username}» حذف شد و دیگر نمی‌تواند وارد شود.`,
          enable: `«${admin.username}» دوباره می‌تواند وارد شود.`,
        }[action],
      );
    },
  });
  const explain = {
    role:
      otherRole === 'owner'
        ? `«${admin.username}» مالک می‌شود: مدیران، قانون‌های قطعی و بکاپ هم دست او خواهد بود.`
        : admin.you
          ? 'خودتان مدیر عادی می‌شوید و دیگر به این صفحه دسترسی ندارید.'
          : `«${admin.username}» مدیر عادی می‌شود.`,
    password: 'همهٔ نشست‌های باز او بسته می‌شود.',
    disable:
      'حساب پاک نمی‌شود تا سابقهٔ کارهایش بماند؛ فقط دیگر نمی‌تواند وارد شود و نشست‌هایش بسته می‌شود.',
    enable: 'با همان رمز قبلی می‌تواند وارد شود.',
  }[action];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate();
      }}
      className="mt-3 space-y-3 rounded-xl bg-bg p-3"
    >
      <p className="text-sm text-muted">{explain}</p>
      {action === 'password' ? <NewPassword value={newPassword} onChange={setNewPassword} /> : null}
      {action === 'disable' || action === 'enable' ? (
        <Field label="دلیل (اختیاری)">
          <input
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className={input}
          />
        </Field>
      ) : null}
      <OwnPassword value={password} onChange={setPassword} />
      {run.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(run.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!password || (action === 'password' && !newPassword) || run.isPending}
          className={`${button} text-white ${action === 'disable' ? 'bg-danger/80' : 'bg-accent-strong'}`}
        >
          {
            {
              role: `${ROLE_LABEL[otherRole]} شود`,
              password: 'ثبت رمز تازه',
              disable: 'حذف کن',
              enable: 'برگردان',
            }[action]
          }
        </button>
        <button
          type="button"
          onClick={() => onDone()}
          className={`${button} border border-line text-muted`}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}

function AdminRow({
  admin,
  onNotice,
}: {
  admin: AdminListItemView;
  onNotice: (msg: string) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const disabled = admin.disabledAt !== null;
  const actions: { key: Action; label: string; icon: typeof KeyRound; show: boolean }[] = [
    {
      key: 'role',
      label: admin.role === 'owner' ? 'مدیر عادی شود' : 'مالک شود',
      icon: ShieldCheck,
      show: !disabled,
    },
    { key: 'password', label: 'رمز تازه', icon: KeyRound, show: !disabled && !admin.you },
    { key: 'disable', label: 'حذف', icon: UserMinus, show: !disabled && !admin.you },
    { key: 'enable', label: 'برگرداندن', icon: UserRoundCheck, show: disabled },
  ];
  return (
    <li className={`rounded-xl bg-raised p-3 ${disabled ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold" dir="ltr">
          {admin.username}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${admin.role === 'owner' ? 'border-accent/40 text-accent' : 'border-line text-muted'}`}
        >
          {ROLE_LABEL[admin.role]}
        </span>
        {admin.you ? (
          <span className="rounded-full border border-ok/40 px-2 py-0.5 text-xs text-ok">شما</span>
        ) : null}
        {disabled ? (
          <span className="rounded-full border border-danger/40 px-2 py-0.5 text-xs text-danger">
            حذف‌شده {formatDateTime(admin.disabledAt!)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        آخرین ورود: {admin.lastLoginAt ? formatRelative(admin.lastLoginAt) : 'هرگز'} ·{' '}
        {formatNumber(admin.activeSessions)} نشست باز · ساخته‌شده {formatDateTime(admin.createdAt)}
      </p>
      {action === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {actions
            .filter((a) => a.show)
            .map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setAction(a.key)}
                className={`inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-ink ${a.key === 'disable' ? 'hover:border-danger hover:text-danger' : ''}`}
              >
                <a.icon aria-hidden className="size-3.5" />
                {a.label}
              </button>
            ))}
        </div>
      ) : (
        <ActionForm
          admin={admin}
          action={action}
          onDone={(msg) => {
            setAction(null);
            if (msg) onNotice(msg);
          }}
        />
      )}
    </li>
  );
}

export function AdminsPage() {
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admins'],
    queryFn: () => api.get<AdminListItemView[]>('/api/admins'),
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const owners = query.data.filter((a) => a.role === 'owner' && a.disabledAt === null).length;
  return (
    <>
      <PageHeader title="مدیران">
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNotice(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-3 py-1.5 text-sm text-white"
          >
            <UserPlus aria-hidden className="size-4" />
            مدیر تازه
          </button>
        ) : null}
      </PageHeader>
      {notice ? (
        <p role="status" className="mb-4 rounded-xl bg-raised px-3 py-2 text-sm text-ok">
          {notice}
        </p>
      ) : null}
      {adding ? (
        <AddAdmin
          onDone={(msg) => {
            setAdding(false);
            if (msg) setNotice(msg);
          }}
        />
      ) : null}
      <section className={card}>
        <p className="mb-3 text-sm text-muted">
          هر تغییری اینجا رمز خودتان را دوباره می‌خواهد و در سابقهٔ کارها ثبت می‌شود. آخرین مالک
          فعال ({formatNumber(owners)} مالک فعال هست) پایین آورده یا حذف نمی‌شود.
        </p>
        <ul className="space-y-2">
          {query.data.map((a) => (
            <AdminRow key={a.id} admin={a} onNotice={setNotice} />
          ))}
        </ul>
      </section>
    </>
  );
}
