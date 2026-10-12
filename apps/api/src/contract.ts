/**
 * Request and response shapes shared by the API and the admin panel. Types and plain
 * constants only, with no imports: the panel bundles this file as is.
 */

export type AdminRole = 'owner' | 'admin';

/** Who may call a route. Checked on the server for every request. */
export type RouteAccess = 'public' | 'admin' | 'owner';

export interface AdminUserView {
  id: number;
  username: string;
  role: AdminRole;
}

export interface AppInfo {
  /** `dev-panel`: local development database with labelled sample data, no Telegram. */
  mode: 'production' | 'dev-panel';
}

export interface SessionView {
  user: AdminUserView;
  /** Send back in the `x-csrf-token` header on every POST, PUT, PATCH and DELETE. */
  csrfToken: string;
  /** The session ends after this much inactivity… */
  idleTimeoutSeconds: number;
  /** …and at this instant (ISO 8601) regardless of activity. */
  expiresAt: string;
  app: AppInfo;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_origin'
  | 'bad_csrf'
  | 'invalid_request'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'not_found'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Persian, safe to show as is. */
    message: string;
    requestId: string;
    /** For `too_many_attempts`. */
    retryAfterSeconds?: number;
  };
}

export const CSRF_HEADER = 'x-csrf-token';
