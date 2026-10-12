import type { ReactNode } from 'react';
import { Inbox, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { ApiError } from '../lib/api.ts';

/** Every data view shows one of these while it has no data to show. */

export function Loading({ label = 'در حال بارگذاری…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-muted">
      <LoaderCircle aria-hidden className="size-5 animate-spin text-accent" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
      <Inbox aria-hidden className="size-8 text-faint" />
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : 'مشکلی پیش آمد. دوباره امتحان کنید.';
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <TriangleAlert aria-hidden className="size-8 text-danger" />
      <p>{message}</p>
      {requestId ? (
        <p className="text-xs text-faint">
          شناسهٔ درخواست: <span className="ltr-nums font-mono">{requestId}</span>
        </p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm hover:bg-raised"
        >
          <RotateCw aria-hidden className="size-4" />
          دوباره
        </button>
      ) : null}
    </div>
  );
}
