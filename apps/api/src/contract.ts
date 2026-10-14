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
  circulation: {
    now: CirculationView;
    daily: CirculationView[];
    /** Earned by idle players but not settled yet (the worker settles hourly). */
    pending: Centi;
  };
  flows: { today: FlowView; week: FlowView; month: FlowView };
  inflation: {
    status: 'ok' | 'warning' | 'not_enough_data';
    day: GrowthView;
    week: GrowthView;
    minCirculation: Centi;
  };
  ghosts: GhostCoverageView;
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

// ───────────────────────── players and transactions (8.3) ─────────────────────────

export type PlatformName = 'telegram' | 'rubika';

export interface PlayerListItemView {
  id: number;
  /** Untrusted display text. */
  displayName: string;
  username: string | null;
  isSample: boolean;
  bannedAt: Instant | null;
  createdAt: Instant;
  level: number;
  levelName: string;
  cash: Centi;
  treasury: Centi;
  identities: { platform: PlatformName; platformUserId: string }[];
  lastActiveAt: Instant | null;
}

export interface PlayerListView {
  items: PlayerListItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NamedKind {
  kind: string;
  /** Persian. */
  name: string;
}

export interface PlayerDetailView {
  user: {
    id: number;
    displayName: string;
    username: string | null;
    isSample: boolean;
    createdAt: Instant;
    bannedAt: Instant | null;
    banReason: string | null;
  };
  identities: { platform: PlatformName; platformUserId: string; createdAt: Instant }[];
  level: number;
  levelName: string;
  maxLevel: number;
  nextLevelCost: Centi | null;
  cash: Centi;
  treasury: Centi;
  tools: { owned: NamedKind[]; equipped: NamedKind | null };
  inventory: (NamedKind & { count: number })[];
  meals: {
    active: (NamedKind & { expiresAt: Instant; deposit: Centi; depositsLeft: number })[];
    capacity: number;
  };
  cemetery: { level: number; hourlyIncome: Centi } | null;
  waits: { kind: string; until: Instant }[];
  ghostsToday: { found: number; limit: number };
  groups: {
    groupId: number;
    title: string;
    platform: PlatformName | null;
    botPresent: boolean;
    status: 'member' | 'left';
    joinedAt: Instant;
    lastSuccessAt: Instant | null;
    streak: number;
  }[];
  ghosts: {
    foundTotal: number;
    heardTotal: number;
    recent: {
      id: number;
      groupId: number;
      groupTitle: string;
      foundAt: Instant;
      heardAt: Instant | null;
      expiresAt: Instant;
      text: string;
    }[];
  };
  streakRewards: {
    date: string;
    groupId: number;
    groupTitle: string;
    streak: number;
    activeMembers: number;
    personal: Centi;
    group: Centi;
  }[];
}

export interface TransactionView {
  id: number;
  kind: string;
  kindName: string;
  effectiveAt: Instant;
  recordedAt: Instant;
  user: { id: number; displayName: string } | null;
  group: { id: number; title: string } | null;
  admin: { id: number; username: string } | null;
  reason: string | null;
  /** Money moved: the sum of the positive entries. */
  amount: Centi;
  /** With a player filter: that player's net change. */
  playerDelta: Centi | null;
  entries: {
    account: 'cash' | 'treasury' | 'blood_bank' | 'system';
    userId: number | null;
    groupId: number | null;
    systemCode: string | null;
    amount: Centi;
  }[];
}

export interface TransactionListView {
  items: TransactionView[];
  /** Opaque; pass back as `cursor` for the next (older) page. */
  next: string | null;
  /** Only on the first page. */
  summary: { count: number; amount: Centi } | null;
}

export interface AdjustBalanceRequest {
  wallet: 'cash' | 'treasury';
  /** Points with up to two decimals, negative to take away, e.g. "-12.5". */
  amount: string;
  reason: string;
  /** Random per form submission: a repeated submit changes nothing. */
  idempotencyKey: string;
}

export interface AdjustBalanceResult {
  transactionId: number | null;
  /** The wallet's new balance; null for a repeated submission (nothing changed). */
  balance: Centi | null;
  duplicate: boolean;
}

export interface BanRequest {
  banned: boolean;
  reason: string;
}

// ───────────────────────── groups (8.4) ─────────────────────────

export interface GroupListItemView {
  id: number;
  /** Untrusted display text. */
  title: string;
  isSample: boolean;
  platform: PlatformName | null;
  chatId: string | null;
  botPresent: boolean;
  disabledAt: Instant | null;
  createdAt: Instant;
  cityLevel: number;
  bloodBank: Centi;
  members: number;
  activeMembers: number;
  lastActivityAt: Instant | null;
  previousChatIds: number;
}

export interface GroupListView {
  items: GroupListItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GroupMigrationItemView {
  id: number;
  platform: PlatformName;
  fromChatId: string;
  toChatId: string;
  groupId: number;
  groupTitle: string;
  status: 'migrated' | 'conflict';
  otherGroup: { id: number; title: string } | null;
  absorbedGroupId: number | null;
  detectedAt: Instant;
  review: { at: Instant; adminUsername: string; note: string | null } | null;
}

export interface GroupDetailView {
  group: {
    id: number;
    title: string;
    isSample: boolean;
    botPresent: boolean;
    botAddedAt: Instant;
    botRemovedAt: Instant | null;
    createdAt: Instant;
    disabledAt: Instant | null;
    disabledReason: string | null;
  };
  identity: { platform: PlatformName; chatId: string; since: Instant } | null;
  previousChatIds: { platform: PlatformName; chatId: string; replacedAt: Instant }[];
  city: {
    level: number;
    maxLevel: number;
    population: { active: number; windowDays: number; requiredForNext: number | null };
    huntStore: {
      points: number;
      donatedTotal: number;
      donatedByFood: (NamedKind & { count: number })[];
    };
    bloodBank: { balance: Centi; level: number; donatedTotal: Centi };
    huntingGround: { level: number; maxForBank: number };
    curses: (NamedKind & { level: number; maxForBank: number })[];
    next: {
      city: { level: number; bloodBankCost: Centi; huntPointsCost: number } | null;
      bloodBank: { level: number; cost: Centi } | null;
      huntingGround: { level: number; cost: Centi } | null;
    };
  };
  members: {
    total: number;
    active: number;
    left: number;
    /** At most 200, active first. */
    list: {
      userId: number;
      displayName: string;
      status: 'member' | 'left';
      banned: boolean;
      joinedAt: Instant;
      lastSuccessAt: Instant | null;
      active: boolean;
    }[];
  };
  leaderboard: {
    rank: number;
    userId: number;
    displayName: string;
    points: Centi;
    levelName: string;
  }[];
  migrations: GroupMigrationItemView[];
}

export interface DisableGroupRequest {
  disabled: boolean;
  reason: string;
}

export interface MigrationOverviewView {
  openConflicts: GroupMigrationItemView[];
  recent: GroupMigrationItemView[];
  groupsWithPreviousIds: {
    groupId: number;
    title: string;
    platform: PlatformName | null;
    chatId: string | null;
    previous: { chatId: string; replacedAt: Instant }[];
  }[];
}

// ───────────────────────── economy settings (8.5) ─────────────────────────

export type ConfigLabelName = 'fixed' | 'suggested';

/** One editable value of the game configuration, described from its schema. */
export interface ConfigFieldView {
  /** e.g. `levels[2].upgradeCost` */
  path: string;
  /** Top-level section key, e.g. `levels`. */
  section: string;
  label: ConfigLabelName;
  /** Persian: what the value means (from the fixed/suggested rules). */
  description: string;
  /** Persian: which item it belongs to, e.g. «سطح ۳» or «چاقو»; empty when obvious. */
  context: string;
  /** Section of the specification it comes from. */
  source: string;
  kind: 'integer' | 'choice';
  min?: number;
  max?: number;
  /** `choice` fields; `null` is offered when `nullable`. */
  options?: { value: string; name: string }[];
  nullable: boolean;
  /** Structural values (level numbers, «no cost on the last level») are shown, not edited. */
  readOnly: boolean;
  /** Basis points: 100 bp = 1 %. */
  basisPoints: boolean;
  value: number | string | null;
}

export interface ConfigFormView {
  versionId: number;
  effectiveFrom: Instant;
  source: 'default' | 'panel';
  note: string;
  createdBy: string | null;
  sections: { key: string; title: string; fields: ConfigFieldView[] }[];
  /** The whole document, to send back edited. */
  config: Record<string, unknown>;
}

export interface ConfigChangeView {
  path: string;
  label: ConfigLabelName;
  description: string;
  context: string;
  before: unknown;
  after: unknown;
}

export type ConfigPreviewView =
  | { status: 'invalid'; issues: { path: string; message: string }[] }
  | { status: 'ok'; baseVersionId: number; changes: ConfigChangeView[]; needsOwner: boolean };

export interface SaveConfigRequest {
  config: Record<string, unknown>;
  note: string;
  baseVersionId: number;
  /** Required when an owner rule changes (owner only). */
  password?: string;
}

export interface ConfigVersionView {
  id: number;
  source: 'default' | 'panel';
  note: string;
  effectiveFrom: Instant;
  createdBy: string | null;
  ownerApprovedBy: string | null;
  changeCount: number;
  ownerRulesChanged: boolean;
  current: boolean;
}

export interface ConfigVersionDetailView extends Omit<
  ConfigVersionView,
  'changeCount' | 'ownerRulesChanged' | 'current'
> {
  changes: ConfigChangeView[];
}

export interface RollbackConfigRequest {
  note: string;
  baseVersionId: number;
  password?: string;
}

// ───────────────────────── ghost content (8.6) ─────────────────────────

export type GhostBatchStatus = 'scheduled' | 'active' | 'retired' | 'cancelled';

export interface GhostBatchView {
  id: number;
  batchId: string;
  /** Tehran date (YYYY-MM-DD) the batch goes live at midnight. */
  activeDate: string;
  status: GhostBatchStatus;
  isSample: boolean;
  source: 'file' | 'panel' | 'dev_seed';
  importedAt: Instant;
  importedBy: string | null;
  activatedAt: Instant | null;
  retiredAt: Instant | null;
  /** Ghosts found with its texts, and how many were answered with «شنیدم». */
  encounters: number;
  heard: number;
}

export interface GhostCoverageView {
  today: string;
  lookaheadDays: number;
  /** Tehran days from tomorrow to `lookaheadDays` ahead with no batch waiting. */
  missingDates: string[];
  /** No live batch at all, or the live one is older than today. */
  warning: 'no_active_batch' | 'stale_batch' | null;
}

export interface GhostOverviewView extends GhostCoverageView {
  limits: { batchSize: number; maxStoryLength: number; decidedBy: PlatformName };
  active: GhostBatchView | null;
  upcoming: GhostBatchView[];
  past: GhostBatchView[];
  pastTotal: number;
}

export interface GhostBatchDetailView {
  batch: GhostBatchView;
  stories: {
    position: number;
    storyKey: string;
    text: string;
    encounters: number;
    heard: number;
  }[];
  cancellation: { by: string | null; reason: string | null; at: Instant } | null;
}

export interface AddGhostBatchRequest {
  activeDate: string;
  texts: string[];
}

export type AddGhostBatchView =
  | { status: 'imported'; id: number; batchId: string; activeDate: string; live: boolean }
  | { status: 'already_imported'; batchId: string }
  /** Persian reasons: for the date, for each text (null when fine) and for the form. */
  | { status: 'invalid'; activeDate: string | null; texts: (string | null)[]; form: string | null };

// ───────────────────────── announcements (8.7) ─────────────────────────

export type AnnouncementTargetRequest = { kind: 'all_groups' } | { kind: 'group'; groupId: number };

export interface AnnouncementRecipientsView {
  count: number;
  byPlatform: { platform: PlatformName; count: number }[];
  /** A few recipient names, for the preview. */
  sample: string[];
  /** Groups left out: disabled (only for «every group»), bot removed, no enabled platform. */
  skipped: { disabled: number; botRemoved: number; otherPlatform: number };
  maxLength: number;
}

export interface SendAnnouncementRequest {
  target: AnnouncementTargetRequest;
  text: string;
  /** Delivered without a notification sound. */
  silent: boolean;
}

export interface DeliveryCountsView {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface AnnouncementView {
  id: number;
  text: string;
  target: 'all_groups' | 'group';
  group: { id: number; title: string } | null;
  silent: boolean;
  createdBy: string | null;
  createdAt: Instant;
  cancelledAt: Instant | null;
  cancelledBy: string | null;
  counts: DeliveryCountsView;
  lastSentAt: Instant | null;
}

export interface AnnouncementListView {
  items: AnnouncementView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AnnouncementDeliveryView {
  groupId: number | null;
  title: string | null;
  platform: PlatformName;
  chatId: string;
  status: 'pending' | 'sent' | 'dead' | 'cancelled';
  attempts: number;
  lastError: string | null;
  sentAt: Instant | null;
  nextAttemptAt: Instant;
}

export interface AnnouncementDetailView extends AnnouncementView {
  deliveries: AnnouncementDeliveryView[];
}

// ───────────────────────── admins, account and audit log (8.8) ─────────────────────────

export interface AdminListItemView {
  id: number;
  username: string;
  role: AdminRole;
  createdAt: Instant;
  /** Set when the account was removed (disabled); it can be enabled again. */
  disabledAt: Instant | null;
  lastLoginAt: Instant | null;
  activeSessions: number;
  /** The signed-in owner looking at the list. */
  you: boolean;
}

export interface CreateAdminRequest {
  username: string;
  newPassword: string;
  role: AdminRole;
  /** The owner's own password, entered again. */
  password: string;
}

export interface SessionItemView {
  id: string;
  createdAt: Instant;
  lastSeenAt: Instant;
  expiresAt: Instant;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface AccountView {
  user: AdminUserView;
  createdAt: Instant;
  passwordMinLength: number;
  sessions: SessionItemView[];
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface AuditEntryView {
  id: number;
  createdAt: Instant;
  actor: 'admin' | 'system';
  admin: { id: number; username: string } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  requestId: string | null;
}

export interface AuditListView {
  items: AuditEntryView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditFiltersView {
  admins: { id: number; username: string }[];
  actions: string[];
  targetTypes: string[];
}
