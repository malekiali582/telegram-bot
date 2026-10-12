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
  | 'wrong_password'
  | 'conflict'
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

// ───────────────────────── dashboard and system (8.2) ─────────────────────────

/** Money in centi-points (1 point = 100) as a decimal string: exact beyond 2^53. */
export type Centi = string;
/** ISO 8601 instant. */
export type Instant = string;

export interface CirculationView {
  /** Tehran calendar day, YYYY-MM-DD; the value is at the end of that day (today: now). */
  date: string;
  cash: Centi;
  treasury: Centi;
  bloodBank: Centi;
  total: Centi;
}

export interface FlowView {
  /** `code` is a system account such as `mint:lolo` or `burn:tool`. */
  produced: { code: string; centi: Centi }[];
  consumed: { code: string; centi: Centi }[];
  adjustments: Centi;
  net: Centi;
}

export interface GrowthView {
  from: string;
  to: string;
  base: Centi;
  change: Centi;
  /** Basis points (100 = 1 %); null when circulation was too small to judge. */
  growthBp: number | null;
  thresholdBp: number;
  exceeded: boolean;
}

export type ServiceState = 'online' | 'stopped' | 'unresponsive' | 'never';

export interface SystemSummaryView {
  bot: ServiceState;
  worker: ServiceState;
  /** Jobs whose last run failed, or that are overdue. */
  jobsWithProblems: number;
  pendingMessages: number;
  deadMessages: number;
  /** Failed job runs in the last 24 hours. */
  failedRuns24h: number;
}

export interface DashboardView {
  today: string;
  players: {
    total: number;
    banned: number;
    activeToday: number;
    active7d: number;
    active30d: number;
  };
  groups: { total: number; withBot: number; activeToday: number };
  circulation: { now: CirculationView; daily: CirculationView[] };
  flows: { today: FlowView; week: FlowView; month: FlowView };
  inflation: {
    status: 'ok' | 'warning' | 'not_enough_data';
    day: GrowthView;
    week: GrowthView;
    minCirculation: Centi;
  };
  system: SystemSummaryView;
}

export interface ServiceInstanceView {
  service: 'bot' | 'worker';
  instance: string;
  state: Exclude<ServiceState, 'never'>;
  startedAt: Instant;
  lastSeenAt: Instant;
  stoppedAt: Instant | null;
  details: Record<string, unknown>;
}

export interface JobRunView {
  id: number;
  job: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: Instant;
  finishedAt: Instant | null;
  error: string | null;
}

export interface JobView {
  name: string;
  nextRunAt: Instant;
  lastStartedAt: Instant | null;
  lastFinishedAt: Instant | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** A worker holds the job right now. */
  running: boolean;
  /** Should have run more than 5 minutes ago and nobody is running it. */
  overdue: boolean;
  recentRuns: JobRunView[];
}

export interface OutboxMessageView {
  id: number;
  platform: 'telegram' | 'rubika';
  kind: 'send' | 'edit' | 'answer_button';
  status: 'pending' | 'sent' | 'dead';
  chatId: string | null;
  group: { id: number; title: string } | null;
  /** Untrusted text: shown as plain text only. */
  text: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Instant;
  nextAttemptAt: Instant;
}

export interface SystemView {
  now: Instant;
  summary: SystemSummaryView;
  services: ServiceInstanceView[];
  jobs: JobView[];
  recentFailures: JobRunView[];
  outbox: {
    pending: number;
    dead: number;
    sent24h: number;
    oldestPendingAt: Instant | null;
    /** A worker holds the sender lease right now. */
    senderActive: boolean;
    deadMessages: OutboxMessageView[];
  };
}

export interface BackupView {
  name: string;
  bytes: number;
  createdAt: Instant;
}

export interface BackupCreatedView extends BackupView {
  sha256: string;
  rows: Record<string, number>;
}

/** Body of every request that re-asks the password (backups, managing admins, owner rules). */
export interface PasswordConfirmation {
  password: string;
}
