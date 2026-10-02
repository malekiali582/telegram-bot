-- LULU initial schema.
-- Conventions:
--   * Money is stored in centi-points (1 LuluPoint = 100) as numeric(78,0): daily 3 %
--     compound interest outgrows bigint within a few years, numeric(78,0) does not.
--   * All instants are timestamptz (stored UTC). Tehran calendar days are `date` columns
--     computed by the application with IANA tz data.
--   * Platform ids (Telegram, Rubika, ...) live only in *_identities tables; everything
--     else references internal ids.

-- ───────────────────────── identities ─────────────────────────

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name  text        NOT NULL,
  username      text,
  is_bot        boolean     NOT NULL DEFAULT false,
  banned_at     timestamptz,
  ban_reason    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_ban_has_reason CHECK ((banned_at IS NULL) = (ban_reason IS NULL))
);

CREATE TABLE user_identities (
  platform          text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  platform_user_id  text        NOT NULL,
  user_id           bigint      NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_user_id)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE groups (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title           text        NOT NULL,
  bot_status      text        NOT NULL DEFAULT 'member' CHECK (bot_status IN ('member', 'removed')),
  bot_added_at    timestamptz NOT NULL DEFAULT now(),
  bot_removed_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Current platform chat id of each group. A supergroup migration updates the row in place.
CREATE TABLE group_identities (
  platform          text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  platform_chat_id  text        NOT NULL,
  group_id          bigint      NOT NULL REFERENCES groups (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_chat_id),
  CONSTRAINT group_identities_one_per_platform UNIQUE (group_id, platform)
);

-- Chat ids a group used before a migration, so late updates from the old id still
-- resolve to the same city instead of creating a new one.
CREATE TABLE group_identity_history (
  platform          text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  platform_chat_id  text        NOT NULL,
  group_id          bigint      NOT NULL REFERENCES groups (id),
  replaced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_chat_id)
);

CREATE TABLE memberships (
  group_id         bigint      NOT NULL REFERENCES groups (id),
  user_id          bigint      NOT NULL REFERENCES users (id),
  status           text        NOT NULL DEFAULT 'member' CHECK (status IN ('member', 'left')),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  left_at          timestamptz,
  -- last successful activity in this group; drives the "active population" rule
  last_success_at  timestamptz,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_active_idx ON memberships (group_id, last_success_at) WHERE status = 'member';

-- ───────────────────────── admin & config ─────────────────────────

CREATE TABLE admin_users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       text        NOT NULL CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 32),
  password_hash  text        NOT NULL,
  role           text        NOT NULL CHECK (role IN ('owner', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);
CREATE UNIQUE INDEX admin_users_username_key ON admin_users (username);

-- Every economy configuration ever used. Operations record the version they ran with,
-- so a later change never applies retroactively.
CREATE TABLE config_versions (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config                      jsonb       NOT NULL,
  source                      text        NOT NULL CHECK (source IN ('default', 'panel')),
  note                        text        NOT NULL DEFAULT '',
  effective_from              timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_admin_id         bigint REFERENCES admin_users (id),
  -- set when the change touched a `fixed` owner rule
  owner_approved_by_admin_id  bigint REFERENCES admin_users (id)
);
CREATE INDEX config_versions_effective_idx ON config_versions (effective_from DESC, id DESC);

-- ───────────────────────── money: wallets & double-entry ledger ─────────────────────────

CREATE TABLE wallets (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text           NOT NULL CHECK (kind IN ('user_cash', 'user_treasury', 'group_blood_bank', 'system')),
  user_id      bigint REFERENCES users (id),
  group_id     bigint REFERENCES groups (id),
  system_code  text CHECK (system_code ~ '^(mint|burn|adjust):[a-z_]+$'),
  -- maintained exclusively by the ledger trigger (0002_guards.sql)
  balance      numeric(78, 0) NOT NULL DEFAULT 0,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT wallets_owner CHECK (
    (kind IN ('user_cash', 'user_treasury') AND user_id IS NOT NULL AND group_id IS NULL AND system_code IS NULL)
    OR (kind = 'group_blood_bank' AND group_id IS NOT NULL AND user_id IS NULL AND system_code IS NULL)
    OR (kind = 'system' AND system_code IS NOT NULL AND user_id IS NULL AND group_id IS NULL)
  ),
  -- only system source/sink accounts may go negative (mint accounts do by design)
  CONSTRAINT wallets_non_negative CHECK (kind = 'system' OR balance >= 0)
);
CREATE UNIQUE INDEX wallets_user_kind_key ON wallets (user_id, kind) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX wallets_group_kind_key ON wallets (group_id, kind) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX wallets_system_code_key ON wallets (system_code) WHERE system_code IS NOT NULL;

INSERT INTO wallets (kind, system_code) VALUES
  ('system', 'mint:lolo'),
  ('system', 'mint:food'),
  ('system', 'mint:cemetery'),
  ('system', 'mint:interest'),
  ('system', 'burn:level_upgrade'),
  ('system', 'burn:tool'),
  ('system', 'burn:cemetery'),
  ('system', 'burn:city_upgrade'),
  ('system', 'burn:blood_bank_upgrade'),
  ('system', 'burn:hunting_ground_upgrade'),
  ('system', 'burn:curse'),
  ('system', 'adjust:admin');

CREATE TABLE transactions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind               text        NOT NULL CHECK (kind ~ '^[a-z_]+$'),
  -- the instant the transaction belongs to (e.g. the midnight boundary for interest)
  effective_at       timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  user_id            bigint REFERENCES users (id),
  group_id           bigint REFERENCES groups (id),
  config_version_id  bigint REFERENCES config_versions (id),
  admin_user_id      bigint REFERENCES admin_users (id),
  reason             text,
  request_id         text,
  idempotency_key    text,
  metadata           jsonb       NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX transactions_idempotency_key ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX transactions_user_idx ON transactions (user_id, effective_at);
CREATE INDEX transactions_group_idx ON transactions (group_id, effective_at);
CREATE INDEX transactions_effective_idx ON transactions (effective_at);

CREATE TABLE ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  bigint         NOT NULL REFERENCES transactions (id),
  wallet_id       bigint         NOT NULL REFERENCES wallets (id),
  amount          numeric(78, 0) NOT NULL CHECK (amount <> 0),
  -- filled in by the ledger trigger from the wallet's new balance
  balance_after   numeric(78, 0) NOT NULL DEFAULT 0,
  created_at      timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_wallet_idx ON ledger_entries (wallet_id, id);

-- ───────────────────────── player ─────────────────────────

CREATE TABLE tool_definitions (
  kind        text PRIMARY KEY CHECK (kind ~ '^[a-z_]+$'),
  sort_order  integer NOT NULL UNIQUE
);
INSERT INTO tool_definitions (kind, sort_order) VALUES
  ('knife', 1), ('axe', 2), ('sword', 3), ('bow', 4), ('magic_wand', 5);

-- The primary key makes buying the same tool twice impossible.
CREATE TABLE owned_tools (
  user_id         bigint      NOT NULL REFERENCES users (id),
  tool_kind       text        NOT NULL REFERENCES tool_definitions (kind),
  acquired_at     timestamptz NOT NULL,
  transaction_id  bigint      NOT NULL REFERENCES transactions (id),
  PRIMARY KEY (user_id, tool_kind)
);

-- One row per player; `SELECT … FOR UPDATE` on it is the player-wide mutex shared by
-- every group.
CREATE TABLE player_state (
  user_id                  bigint PRIMARY KEY REFERENCES users (id),
  level                    integer     NOT NULL DEFAULT 1 CHECK (level >= 1),
  fear                     bigint      NOT NULL DEFAULT 0 CHECK (fear >= 0),
  equipped_tool            text,
  -- start of the account; replaces last_lolo_at for the first food window
  started_at               timestamptz NOT NULL DEFAULT now(),
  last_lolo_at             timestamptz,
  -- last Tehran midnight (as a date) whose treasury interest has been applied
  interest_settled_through date,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- the equipped tool must be one the player owns
  CONSTRAINT player_state_equipped_owned FOREIGN KEY (user_id, equipped_tool)
    REFERENCES owned_tools (user_id, tool_kind)
);

CREATE TABLE inventory (
  user_id   bigint NOT NULL REFERENCES users (id),
  food      text   NOT NULL CHECK (food IN ('bone', 'mouse', 'chicken', 'pig', 'sheep', 'cow', 'deer', 'human')),
  quantity  bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (user_id, food)
);

-- One row per eaten meal, active on [started_at, expires_at).
CREATE TABLE food_effects (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint      NOT NULL REFERENCES users (id),
  food               text        NOT NULL CHECK (food IN ('bone', 'mouse', 'chicken', 'pig', 'sheep', 'cow', 'deer', 'human')),
  nutrition          integer     NOT NULL CHECK (nutrition > 0),
  points_per_second  integer     NOT NULL CHECK (points_per_second > 0),
  started_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT food_effects_positive_duration CHECK (expires_at > started_at)
);
CREATE INDEX food_effects_user_expiry_idx ON food_effects (user_id, expires_at);

-- Global (all-group) cooldowns, recorded with the buff snapshot of the group the action
-- happened in. Later group changes never shorten an already recorded wait.
CREATE TABLE cooldowns (
  user_id            bigint      NOT NULL REFERENCES users (id),
  kind               text        NOT NULL CHECK (kind IN ('lolo', 'hunt', 'ghost')),
  available_at       timestamptz NOT NULL,
  set_at             timestamptz NOT NULL,
  group_id           bigint REFERENCES groups (id),
  base_seconds       integer     NOT NULL CHECK (base_seconds > 0),
  effective_seconds  integer     NOT NULL CHECK (effective_seconds > 0),
  PRIMARY KEY (user_id, kind)
);

-- Throttle for "time remaining" replies, per player per group.
CREATE TABLE wait_notices (
  user_id       bigint      NOT NULL REFERENCES users (id),
  group_id      bigint      NOT NULL REFERENCES groups (id),
  kind          text        NOT NULL CHECK (kind IN ('lolo', 'hunt', 'ghost')),
  last_sent_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, group_id, kind)
);

CREATE TABLE cemeteries (
  user_id            bigint PRIMARY KEY REFERENCES users (id),
  level              integer     NOT NULL DEFAULT 0 CHECK (level >= 0),
  opened_at          timestamptz NOT NULL,
  -- income has been credited up to this instant
  accrued_until      timestamptz NOT NULL,
  -- fractional income carried between settlements; unit defined by the domain service
  accrual_remainder  bigint      NOT NULL DEFAULT 0 CHECK (accrual_remainder >= 0),
  config_version_id  bigint REFERENCES config_versions (id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per player per Tehran midnight; the primary key prevents double interest.
CREATE TABLE interest_settlements (
  user_id         bigint         NOT NULL REFERENCES users (id),
  boundary_date   date           NOT NULL,
  balance_before  numeric(78, 0) NOT NULL CHECK (balance_before >= 0),
  interest        numeric(78, 0) NOT NULL CHECK (interest >= 0),
  rate_bp         integer        NOT NULL CHECK (rate_bp >= 0),
  -- null when the interest was zero (no ledger movement)
  transaction_id  bigint REFERENCES transactions (id),
  created_at      timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, boundary_date)
);

-- ───────────────────────── groups: «لولوآباد» ─────────────────────────

CREATE TABLE settlements (
  group_id                   bigint PRIMARY KEY REFERENCES groups (id),
  level                      integer        NOT NULL DEFAULT 1 CHECK (level >= 1),
  -- spendable hunt-point pool (sum of donated count × nutrition, minus upgrades)
  hunt_points                bigint         NOT NULL DEFAULT 0 CHECK (hunt_points >= 0),
  hunt_points_donated_total  bigint         NOT NULL DEFAULT 0 CHECK (hunt_points_donated_total >= 0),
  blood_donated_total        numeric(78, 0) NOT NULL DEFAULT 0 CHECK (blood_donated_total >= 0),
  created_at                 timestamptz    NOT NULL DEFAULT now(),
  updated_at                 timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE blood_banks (
  group_id    bigint PRIMARY KEY REFERENCES groups (id),
  level       integer     NOT NULL DEFAULT 1 CHECK (level >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hunting_grounds (
  group_id    bigint PRIMARY KEY REFERENCES groups (id),
  level       integer     NOT NULL DEFAULT 1 CHECK (level >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE curses (
  group_id    bigint      NOT NULL REFERENCES groups (id),
  kind        text        NOT NULL CHECK (kind IN ('hunt_haste', 'lolo_echo')),
  level       integer     NOT NULL DEFAULT 0 CHECK (level >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, kind)
);

-- History of donated prey by type (kept separately from the spendable pool).
CREATE TABLE settlement_inventory (
  group_id       bigint NOT NULL REFERENCES groups (id),
  food           text   NOT NULL CHECK (food IN ('bone', 'mouse', 'chicken', 'pig', 'sheep', 'cow', 'deer', 'human')),
  donated_count  bigint NOT NULL DEFAULT 0 CHECK (donated_count >= 0),
  PRIMARY KEY (group_id, food)
);

-- ───────────────────────── ghosts ─────────────────────────

CREATE TABLE ghost_batches (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_key             text        NOT NULL UNIQUE,
  active_date           date        NOT NULL,
  timezone              text        NOT NULL CHECK (timezone = 'Asia/Tehran'),
  status                text        NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN ('scheduled', 'active', 'retired', 'cancelled')),
  is_sample             boolean     NOT NULL DEFAULT false,
  source                text        NOT NULL CHECK (source IN ('file', 'panel', 'dev_seed')),
  content_hash          text        NOT NULL,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  retired_at            timestamptz,
  imported_by_admin_id  bigint REFERENCES admin_users (id)
);
-- at most one live batch, and one pending batch per Tehran date
CREATE UNIQUE INDEX ghost_batches_single_active ON ghost_batches ((true)) WHERE status = 'active';
CREATE UNIQUE INDEX ghost_batches_scheduled_date ON ghost_batches (active_date) WHERE status = 'scheduled';

CREATE TABLE ghost_stories (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id   bigint  NOT NULL REFERENCES ghost_batches (id),
  story_key  text    NOT NULL,
  position   integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  text       text    NOT NULL CHECK (length(btrim(text)) > 0),
  CONSTRAINT ghost_stories_key_per_batch UNIQUE (batch_id, story_key),
  CONSTRAINT ghost_stories_position_per_batch UNIQUE (batch_id, position)
);

CREATE TABLE ghost_encounters (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id),
  group_id         bigint      NOT NULL REFERENCES groups (id),
  story_id         bigint      NOT NULL REFERENCES ghost_stories (id),
  tehran_date      date        NOT NULL,
  -- copy of the text as shown, independent of later batch changes
  text_snapshot    text        NOT NULL,
  fear_reward      integer     NOT NULL CHECK (fear_reward >= 0),
  found_at         timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  platform         text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  message_chat_id  text        NOT NULL,
  -- set once the outbox has delivered the ghost message
  message_id       text,
  heard_at         timestamptz,
  CONSTRAINT ghost_encounters_deadline CHECK (expires_at > found_at),
  -- no repeated story for the same player on the same day
  CONSTRAINT ghost_encounters_no_repeat UNIQUE (user_id, tehran_date, story_id),
  CONSTRAINT ghost_encounters_message UNIQUE (platform, message_chat_id, message_id)
);
CREATE INDEX ghost_encounters_user_idx ON ghost_encounters (user_id, found_at);

CREATE TABLE daily_ghost_state (
  user_id               bigint  NOT NULL REFERENCES users (id),
  tehran_date           date    NOT NULL,
  found_count           integer NOT NULL DEFAULT 0 CHECK (found_count >= 0),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  PRIMARY KEY (user_id, tehran_date)
);

-- ───────────────────────── platform plumbing ─────────────────────────

CREATE TABLE processed_updates (
  platform      text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  update_id     text        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, update_id)
);
CREATE INDEX processed_updates_age_idx ON processed_updates (processed_at);

-- Messages are written here in the same transaction as the game result and delivered
-- by the worker; a failed send never repeats the money movement.
CREATE TABLE outbox (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform         text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  kind             text        NOT NULL CHECK (kind IN ('send', 'edit', 'answer_button')),
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  -- follow-up to run after delivery, e.g. recording a ghost message id
  on_sent          jsonb,
  result           jsonb,
  dedupe_key       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, id) WHERE status = 'pending';
CREATE UNIQUE INDEX outbox_dedupe_key ON outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Single-use confirmation buttons bound to user, action and fixed parameters.
CREATE TABLE pending_confirmations (
  token       text PRIMARY KEY CHECK (length(token) >= 16),
  user_id     bigint      NOT NULL REFERENCES users (id),
  action      text        NOT NULL CHECK (action ~ '^[a-z_]+$'),
  params      jsonb       NOT NULL DEFAULT '{}',
  group_id    bigint REFERENCES groups (id),
  platform    text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  chat_id     text        NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT pending_confirmations_ttl CHECK (expires_at > created_at)
);
CREATE INDEX pending_confirmations_user_idx ON pending_confirmations (user_id, expires_at);

-- ───────────────────────── jobs (PostgreSQL-only scheduling) ─────────────────────────

CREATE TABLE job_state (
  name                  text PRIMARY KEY,
  next_run_at           timestamptz NOT NULL,
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_started_at       timestamptz,
  last_finished_at      timestamptz,
  last_error            text,
  consecutive_failures  integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_state_lease CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE job_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name     text        NOT NULL,
  lease_owner  text        NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  status       text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error        text,
  stats        jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX job_runs_job_idx ON job_runs (job_name, started_at DESC);
CREATE INDEX job_runs_failed_idx ON job_runs (started_at DESC) WHERE status = 'failed';

-- ───────────────────────── admin panel ─────────────────────────

CREATE TABLE admin_sessions (
  -- SHA-256 of the session token; the raw token only ever lives in the cookie
  token_hash       text PRIMARY KEY,
  admin_user_id    bigint      NOT NULL REFERENCES admin_users (id),
  csrf_token_hash  text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  ip               text,
  user_agent       text
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions (admin_user_id);

CREATE TABLE admin_login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL,
  ip            text        NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  succeeded     boolean     NOT NULL
);
CREATE INDEX admin_login_attempts_username_idx ON admin_login_attempts (username, attempted_at);
CREATE INDEX admin_login_attempts_ip_idx ON admin_login_attempts (ip, attempted_at);

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor          text        NOT NULL CHECK (actor IN ('admin', 'system')),
  admin_user_id  bigint REFERENCES admin_users (id),
  action         text        NOT NULL,
  target_type    text,
  target_id      text,
  reason         text,
  details        jsonb       NOT NULL DEFAULT '{}',
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_admin_actor CHECK (actor = 'system' OR admin_user_id IS NOT NULL)
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
