/**
 * Typed view of the schema for queries. The SQL files in `../migrations` are the source
 * of truth (they also hold triggers, partial indexes and checks); `schema.test.ts`
 * fails if a table or column here drifts from the migrated database.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Centi-points as `bigint`. numeric(78,0) because compound interest outgrows int8. */
export const money = customType<{ data: bigint; driverData: string | number }>({
  dataType: () => 'numeric(78,0)',
  toDriver: (value) => value.toString(),
  fromDriver: (value) => BigInt(value),
});

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: 'number' });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** A Tehran calendar day, `YYYY-MM-DD`. */
const day = (name: string) => date(name, { mode: 'string' });

export type Platform = 'telegram' | 'rubika';

// ───────────────────────── identities ─────────────────────────

export const users = pgTable('users', {
  id: id(),
  displayName: text('display_name').notNull(),
  username: text('username'),
  isBot: boolean('is_bot').notNull().default(false),
  bannedAt: instant('banned_at'),
  banReason: text('ban_reason'),
  /** Development sample data (`npm run dev:panel`); never set in production. */
  isSample: boolean('is_sample').notNull().default(false),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const userIdentities = pgTable(
  'user_identities',
  {
    platform: text('platform').$type<Platform>().notNull(),
    platformUserId: text('platform_user_id').notNull(),
    userId: ref('user_id').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.platformUserId] })],
);

export const groups = pgTable('groups', {
  id: id(),
  title: text('title').notNull(),
  botStatus: text('bot_status').$type<'member' | 'removed'>().notNull().default('member'),
  botAddedAt: instant('bot_added_at').notNull().defaultNow(),
  botRemovedAt: instant('bot_removed_at'),
  /** Development sample data (`npm run dev:panel`); never set in production. */
  isSample: boolean('is_sample').notNull().default(false),
  /** Set by an admin: the bot runs no command here (migration 0010). */
  disabledAt: instant('disabled_at'),
  disabledReason: text('disabled_reason'),
  /** Last «this group is disabled» reply, to say it at most every 10 minutes. */
  disabledNoticeAt: instant('disabled_notice_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const groupIdentities = pgTable(
  'group_identities',
  {
    platform: text('platform').$type<Platform>().notNull(),
    platformChatId: text('platform_chat_id').notNull(),
    groupId: ref('group_id').notNull(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.platformChatId] })],
);

export const groupIdentityHistory = pgTable(
  'group_identity_history',
  {
    platform: text('platform').$type<Platform>().notNull(),
    platformChatId: text('platform_chat_id').notNull(),
    groupId: ref('group_id').notNull(),
    replacedAt: instant('replaced_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.platformChatId] })],
);

export const memberships = pgTable(
  'memberships',
  {
    groupId: ref('group_id').notNull(),
    userId: ref('user_id').notNull(),
    status: text('status').$type<'member' | 'left'>().notNull().default('member'),
    joinedAt: instant('joined_at').notNull().defaultNow(),
    leftAt: instant('left_at'),
    lastSuccessAt: instant('last_success_at'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

// ───────────────────────── admin & config ─────────────────────────

export const adminUsers = pgTable('admin_users', {
  id: id(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'owner' | 'admin'>().notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  disabledAt: instant('disabled_at'),
});

export const configVersions = pgTable('config_versions', {
  id: id(),
  config: jsonb('config').notNull(),
  source: text('source').$type<'default' | 'panel'>().notNull(),
  note: text('note').notNull().default(''),
  effectiveFrom: instant('effective_from').notNull().defaultNow(),
  createdAt: instant('created_at').notNull().defaultNow(),
  createdByAdminId: ref('created_by_admin_id'),
  ownerApprovedByAdminId: ref('owner_approved_by_admin_id'),
});

// ───────────────────────── money ─────────────────────────

export type WalletKind = 'user_cash' | 'user_treasury' | 'group_blood_bank' | 'system';

export const wallets = pgTable('wallets', {
  id: id(),
  kind: text('kind').$type<WalletKind>().notNull(),
  userId: ref('user_id'),
  groupId: ref('group_id'),
  systemCode: text('system_code'),
  /**
   * Read-only from application code: maintained by the ledger trigger for user and group
   * wallets. Always 0 for system wallets, whose totals are the sum of their entries.
   */
  balance: money('balance').notNull().default(0n),
  createdAt: instant('created_at').notNull().defaultNow(),
});

export const transactions = pgTable('transactions', {
  id: id(),
  kind: text('kind').notNull(),
  effectiveAt: instant('effective_at').notNull(),
  recordedAt: instant('recorded_at').notNull().defaultNow(),
  userId: ref('user_id'),
  groupId: ref('group_id'),
  configVersionId: ref('config_version_id'),
  adminUserId: ref('admin_user_id'),
  reason: text('reason'),
  requestId: text('request_id'),
  idempotencyKey: text('idempotency_key'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: id(),
  transactionId: ref('transaction_id').notNull(),
  walletId: ref('wallet_id').notNull(),
  amount: money('amount').notNull(),
  /** Wallet balance after this entry (set by the ledger trigger); null for system wallets. */
  balanceAfter: money('balance_after'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

// ───────────────────────── player ─────────────────────────

export const toolDefinitions = pgTable('tool_definitions', {
  kind: text('kind').primaryKey(),
  sortOrder: integer('sort_order').notNull(),
});

export const ownedTools = pgTable(
  'owned_tools',
  {
    userId: ref('user_id').notNull(),
    toolKind: text('tool_kind').notNull(),
    acquiredAt: instant('acquired_at').notNull(),
    transactionId: ref('transaction_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.toolKind] })],
);

export const playerState = pgTable('player_state', {
  userId: ref('user_id').primaryKey(),
  level: integer('level').notNull().default(1),
  startedAt: instant('started_at').notNull().defaultNow(),
  lastLoloAt: instant('last_lolo_at'),
  interestSettledThrough: day('interest_settled_through'),
  /** Tehran day of the first successful «لولو» (account age for the streak reward). */
  firstLoloDate: day('first_lolo_date'),
  /** Last Tehran day whose streak reward has been settled. */
  streakSettledThrough: day('streak_settled_through'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const inventory = pgTable(
  'inventory',
  {
    userId: ref('user_id').notNull(),
    food: text('food').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.food] })],
);

export const foodEffects = pgTable('food_effects', {
  id: id(),
  userId: ref('user_id').notNull(),
  food: text('food').notNull(),
  nutrition: integer('nutrition').notNull(),
  startedAt: instant('started_at').notNull(),
  expiresAt: instant('expires_at').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  /** Paid into cash at started_at + k × interval, for k = 1 … depositsTotal. */
  depositCenti: money('deposit_centi').notNull(),
  depositIntervalSeconds: integer('deposit_interval_seconds').notNull(),
  depositsTotal: integer('deposits_total').notNull(),
  depositsPaid: integer('deposits_paid').notNull().default(0),
});

export type CooldownKind = 'lolo' | 'hunt' | 'ghost';

export const cooldowns = pgTable(
  'cooldowns',
  {
    userId: ref('user_id').notNull(),
    kind: text('kind').$type<CooldownKind>().notNull(),
    availableAt: instant('available_at').notNull(),
    setAt: instant('set_at').notNull(),
    groupId: ref('group_id'),
    baseSeconds: integer('base_seconds').notNull(),
    effectiveSeconds: integer('effective_seconds').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

export const waitNotices = pgTable(
  'wait_notices',
  {
    userId: ref('user_id').notNull(),
    groupId: ref('group_id').notNull(),
    kind: text('kind').$type<CooldownKind>().notNull(),
    lastSentAt: instant('last_sent_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId, t.kind] })],
);

export const cemeteries = pgTable('cemeteries', {
  userId: ref('user_id').primaryKey(),
  level: integer('level').notNull().default(0),
  openedAt: instant('opened_at').notNull(),
  accruedUntil: instant('accrued_until').notNull(),
  accrualRemainder: bigint('accrual_remainder', { mode: 'bigint' }).notNull().default(0n),
  configVersionId: ref('config_version_id'),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const interestSettlements = pgTable(
  'interest_settlements',
  {
    userId: ref('user_id').notNull(),
    boundaryDate: day('boundary_date').notNull(),
    balanceBefore: money('balance_before').notNull(),
    interest: money('interest').notNull(),
    rateBp: integer('rate_bp').notNull(),
    transactionId: ref('transaction_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.boundaryDate] })],
);

// ───────────────────────── groups ─────────────────────────

export const settlements = pgTable('settlements', {
  groupId: ref('group_id').primaryKey(),
  level: integer('level').notNull().default(1),
  huntPoints: bigint('hunt_points', { mode: 'number' }).notNull().default(0),
  huntPointsDonatedTotal: bigint('hunt_points_donated_total', { mode: 'number' })
    .notNull()
    .default(0),
  bloodDonatedTotal: money('blood_donated_total').notNull().default(0n),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const bloodBanks = pgTable('blood_banks', {
  groupId: ref('group_id').primaryKey(),
  level: integer('level').notNull().default(1),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const huntingGrounds = pgTable('hunting_grounds', {
  groupId: ref('group_id').primaryKey(),
  level: integer('level').notNull().default(1),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const curses = pgTable(
  'curses',
  {
    groupId: ref('group_id').notNull(),
    kind: text('kind').notNull(),
    level: integer('level').notNull().default(0),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.kind] })],
);

export const settlementInventory = pgTable(
  'settlement_inventory',
  {
    groupId: ref('group_id').notNull(),
    food: text('food').notNull(),
    donatedCount: bigint('donated_count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.food] })],
);

// ───────────────────────── ghosts ─────────────────────────

export type GhostBatchStatus = 'scheduled' | 'active' | 'retired' | 'cancelled';

export const ghostBatches = pgTable('ghost_batches', {
  id: id(),
  batchKey: text('batch_key').notNull(),
  activeDate: day('active_date').notNull(),
  timezone: text('timezone').notNull(),
  status: text('status').$type<GhostBatchStatus>().notNull().default('scheduled'),
  isSample: boolean('is_sample').notNull().default(false),
  source: text('source').$type<'file' | 'panel' | 'dev_seed'>().notNull(),
  contentHash: text('content_hash').notNull(),
  importedAt: instant('imported_at').notNull().defaultNow(),
  activatedAt: instant('activated_at'),
  retiredAt: instant('retired_at'),
  importedByAdminId: ref('imported_by_admin_id'),
});

export const ghostStories = pgTable('ghost_stories', {
  id: id(),
  batchId: ref('batch_id').notNull(),
  storyKey: text('story_key').notNull(),
  position: integer('position').notNull(),
  text: text('text').notNull(),
});

export const ghostEncounters = pgTable('ghost_encounters', {
  id: id(),
  userId: ref('user_id').notNull(),
  groupId: ref('group_id').notNull(),
  storyId: ref('story_id').notNull(),
  tehranDate: day('tehran_date').notNull(),
  textSnapshot: text('text_snapshot').notNull(),
  foundAt: instant('found_at').notNull(),
  expiresAt: instant('expires_at').notNull(),
  platform: text('platform').$type<Platform>().notNull(),
  messageChatId: text('message_chat_id').notNull(),
  messageId: text('message_id'),
  heardAt: instant('heard_at'),
  /** Fixed when the ghost is found; paid to every active member on «شنیدم». */
  rewardPerMemberCenti: money('reward_per_member_centi').notNull(),
});

export const dailyGhostState = pgTable(
  'daily_ghost_state',
  {
    userId: ref('user_id').notNull(),
    tehranDate: day('tehran_date').notNull(),
    foundCount: integer('found_count').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tehranDate] })],
);

// ───────────────────────── daily streak reward ─────────────────────────

/** A Tehran day with at least one successful «لولو» by the player in the group. */
export const streakDays = pgTable(
  'streak_days',
  {
    userId: ref('user_id').notNull(),
    groupId: ref('group_id').notNull(),
    tehranDate: day('tehran_date').notNull(),
    /** Consecutive days in this group ending on this day. */
    streak: integer('streak').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId, t.tehranDate] })],
);

/** The one streak payment of a player for a Tehran day. */
export const streakRewards = pgTable(
  'streak_rewards',
  {
    userId: ref('user_id').notNull(),
    tehranDate: day('tehran_date').notNull(),
    groupId: ref('group_id').notNull(),
    streak: integer('streak').notNull(),
    activeMembers: integer('active_members').notNull(),
    personalCenti: money('personal_centi').notNull(),
    groupCenti: money('group_centi').notNull(),
    transactionId: ref('transaction_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tehranDate] })],
);

// ───────────────────────── platform plumbing ─────────────────────────

export const processedUpdates = pgTable(
  'processed_updates',
  {
    platform: text('platform').$type<Platform>().notNull(),
    updateId: text('update_id').notNull(),
    processedAt: instant('processed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.updateId] })],
);

export const outbox = pgTable('outbox', {
  id: id(),
  platform: text('platform').$type<Platform>().notNull(),
  kind: text('kind').$type<'send' | 'edit' | 'answer_button'>().notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status')
    .$type<'pending' | 'sent' | 'dead' | 'cancelled'>()
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: instant('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  onSent: jsonb('on_sent'),
  result: jsonb('result'),
  dedupeKey: text('dedupe_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  sentAt: instant('sent_at'),
  /** Set for the messages of an announcement from the panel (0012). */
  announcementId: ref('announcement_id'),
});

/** An admin's message to every group or to one group (0012); delivered via the outbox. */
export const announcements = pgTable('announcements', {
  id: id(),
  text: text('text').notNull(),
  target: text('target').$type<'all_groups' | 'group'>().notNull(),
  groupId: ref('group_id'),
  silent: boolean('silent').notNull().default(false),
  recipients: integer('recipients').notNull(),
  createdByAdminId: ref('created_by_admin_id').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  cancelledAt: instant('cancelled_at'),
  cancelledByAdminId: ref('cancelled_by_admin_id'),
});

export const pendingConfirmations = pgTable('pending_confirmations', {
  token: text('token').primaryKey(),
  userId: ref('user_id').notNull(),
  action: text('action').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  groupId: ref('group_id'),
  platform: text('platform').$type<Platform>().notNull(),
  chatId: text('chat_id').notNull(),
  createdAt: instant('created_at').notNull(),
  /** `null` for a menu button: never expires and can be used again. */
  expiresAt: instant('expires_at'),
  usedAt: instant('used_at'),
});

// ───────────────────────── jobs ─────────────────────────

export const jobState = pgTable('job_state', {
  name: text('name').primaryKey(),
  nextRunAt: instant('next_run_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: instant('lease_expires_at'),
  lastStartedAt: instant('last_started_at'),
  lastFinishedAt: instant('last_finished_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const jobRuns = pgTable('job_runs', {
  id: id(),
  jobName: text('job_name').notNull(),
  leaseOwner: text('lease_owner').notNull(),
  startedAt: instant('started_at').notNull(),
  finishedAt: instant('finished_at'),
  status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
  error: text('error'),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
});

// ───────────────────────── admin panel ─────────────────────────

export const adminSessions = pgTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  adminUserId: ref('admin_user_id').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
  revokedAt: instant('revoked_at'),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const adminLoginAttempts = pgTable('admin_login_attempts', {
  id: id(),
  username: text('username').notNull(),
  ip: text('ip').notNull(),
  attemptedAt: instant('attempted_at').notNull().defaultNow(),
  succeeded: boolean('succeeded').notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  actor: text('actor').$type<'admin' | 'system'>().notNull(),
  adminUserId: ref('admin_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  reason: text('reason'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  requestId: text('request_id'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** Every supergroup migration the bot saw, with conflicts left for an admin (0010). */
export const groupMigrations = pgTable('group_migrations', {
  id: id(),
  platform: text('platform').$type<Platform>().notNull(),
  fromChatId: text('from_chat_id').notNull(),
  toChatId: text('to_chat_id').notNull(),
  groupId: ref('group_id').notNull(),
  status: text('status').$type<'migrated' | 'conflict'>().notNull(),
  otherGroupId: ref('other_group_id'),
  absorbedGroupId: ref('absorbed_group_id'),
  detectedAt: instant('detected_at').notNull(),
  reviewedAt: instant('reviewed_at'),
  reviewedByAdminId: ref('reviewed_by_admin_id'),
  reviewNote: text('review_note'),
});

/** Liveness of each bot and worker process (migration 0008). */
export const serviceHeartbeats = pgTable(
  'service_heartbeats',
  {
    service: text('service').$type<'bot' | 'worker'>().notNull(),
    instance: text('instance').notNull(),
    startedAt: instant('started_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    stoppedAt: instant('stopped_at'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.service, t.instance] })],
);

/** Additional messages showing an encounter (re-posts after a supergroup migration). */
export const ghostMessageRefs = pgTable(
  'ghost_message_refs',
  {
    platform: text('platform').$type<Platform>().notNull(),
    chatId: text('chat_id').notNull(),
    messageId: text('message_id').notNull(),
    encounterId: ref('encounter_id').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.chatId, t.messageId] })],
);
