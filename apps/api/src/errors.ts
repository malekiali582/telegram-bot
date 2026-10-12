import type { z } from 'zod';
import type { ApiErrorCode } from './contract.ts';

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthenticated: 'لطفاً دوباره وارد شوید.',
  forbidden: 'این بخش فقط برای مالک است.',
  bad_origin: 'درخواست از مبدأ مجاز نیامده است.',
  bad_csrf: 'نشست شما تازه نیست. صفحه را دوباره باز کنید.',
  invalid_request: 'اطلاعات فرستاده‌شده درست نیست.',
  invalid_credentials: 'نام کاربری یا رمز درست نیست.',
  too_many_attempts: 'تلاش‌های ناموفق زیاد بود. کمی بعد دوباره امتحان کنید.',
  not_found: 'پیدا نشد.',
  payload_too_large: 'حجم اطلاعات فرستاده‌شده زیاد است.',
  unsupported_media_type: 'قالب درخواست پشتیبانی نمی‌شود.',
  internal: 'خطای داخلی سرور. دوباره امتحان کنید.',
};

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_origin: 403,
  bad_csrf: 403,
  invalid_request: 400,
  invalid_credentials: 401,
  too_many_attempts: 429,
  not_found: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
};

/** An expected failure with a Persian message for the panel. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ApiErrorCode, options: { message?: string; retryAfterSeconds?: number } = {}) {
    super(options.message ?? MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const errorMessage = (code: ApiErrorCode) => MESSAGES[code];

/** Fastify's own client errors (bad JSON, wrong content type, body too large). */
export function codeForStatus(status: number): ApiErrorCode {
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 415) return 'unsupported_media_type';
  return status >= 500 ? 'internal' : 'invalid_request';
}

/** Validates a request body; never echoes submitted values back. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError('invalid_request');
  return result.data;
}
