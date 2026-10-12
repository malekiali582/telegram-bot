import { LoaderCircle, LogIn } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { useLogin } from '../lib/session.ts';
import type { LoggedOutReason } from '../lib/session.ts';

const NOTICE: Record<Exclude<LoggedOutReason, null>, string> = {
  expired: 'نشست شما تمام شد. دوباره وارد شوید.',
  logged_out: 'از پنل خارج شدید.',
};

export function LoginPage({ reason }: { reason: LoggedOutReason }) {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate({ username, password }, { onError: () => setPassword('') });
  };

  const error = login.error;
  const message =
    error instanceof ApiError
      ? error.message
      : error
        ? 'ورود انجام نشد. دوباره امتحان کنید.'
        : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl sm:p-8"
        aria-labelledby="login-title"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 id="login-title" className="text-xl font-bold">
            پنل مدیریت لولو
          </h1>
        </div>

        {reason && !message ? (
          <p role="status" className="mb-4 rounded-lg bg-raised px-3 py-2 text-sm text-muted">
            {NOTICE[reason]}
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {message}
          </p>
        ) : null}

        <label className="mb-4 block">
          <span className="mb-1.5 block text-sm text-muted">نام کاربری</span>
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            dir="ltr"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-start outline-none focus:border-accent"
          />
        </label>
        <label className="mb-6 block">
          <span className="mb-1.5 block text-sm text-muted">رمز</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-start outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={login.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 font-medium text-white hover:bg-accent-strong/90 disabled:opacity-60"
        >
          {login.isPending ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
          ) : (
            <LogIn aria-hidden className="size-4 -scale-x-100" />
          )}
          ورود
        </button>
      </form>
    </main>
  );
}
