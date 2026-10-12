import type { ApiErrorBody, ApiErrorCode } from '@lulu/api/contract';
import { CSRF_HEADER } from '@lulu/api/contract';

/**
 * Calls the panel API on the same origin. The session cookie travels by itself
 * (HttpOnly, SameSite=Strict); writes also carry the session's CSRF token.
 */

export type ClientErrorCode = ApiErrorCode | 'network';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: ClientErrorCode,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestId = options.requestId;
  }
}

let csrfToken: string | null = null;
let onUnauthenticated: () => void = () => {};

/** Called when a session is loaded or ends. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** What to do when the server says the session is gone (show the login page). */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

const NETWORK_MESSAGE = 'اتصال به سرور برقرار نشد. اینترنت یا روشن بودن سرور را بررسی کنید.';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('network', NETWORK_MESSAGE);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return data as T;

  const error = (data as ApiErrorBody | null)?.error;
  if (res.status === 401 && error?.code === 'unauthenticated' && path !== '/api/auth/session') {
    onUnauthenticated();
  }
  throw new ApiError(error?.code ?? 'internal', error?.message ?? 'خطای ناشناخته از سرور.', {
    status: res.status,
    ...(error?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
    ...(error?.requestId ? { requestId: error.requestId } : {}),
  });
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
};
