-- Admin panel, step 8.4: disabling groups, and a record of chat migrations.

-- A disabled group keeps its city and data, but the bot runs no command there. The reason
-- is required. The bot says so at most every 10 minutes per group (disabled_notice_at).
ALTER TABLE groups
  ADD COLUMN disabled_at        timestamptz,
  ADD COLUMN disabled_reason    text,
  ADD COLUMN disabled_notice_at timestamptz,
  ADD CONSTRAINT groups_disable_has_reason
    CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL));

-- Every supergroup migration the bot saw. `conflict`: the new chat id already had a city
-- with real data, so nothing was moved and an admin must look at it; `migrated`: the
-- same city continues under the new id, possibly after absorbing an unused city that had
-- been created for the new id. Migrations before this table exist only as
-- group_identity_history rows.
CREATE TABLE group_migrations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform              text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  from_chat_id          text        NOT NULL,
  to_chat_id            text        NOT NULL,
  group_id              bigint      NOT NULL REFERENCES groups (id),
  status                text        NOT NULL CHECK (status IN ('migrated', 'conflict')),
  -- conflict: the city that already uses the new chat id
  other_group_id        bigint REFERENCES groups (id),
  -- migrated: the unused city folded into this one (it no longer exists)
  absorbed_group_id     bigint,
  detected_at           timestamptz NOT NULL,
  reviewed_at           timestamptz,
  reviewed_by_admin_id  bigint REFERENCES admin_users (id),
  review_note           text,
  CONSTRAINT group_migrations_conflict_other CHECK ((status = 'conflict') = (other_group_id IS NOT NULL)),
  CONSTRAINT group_migrations_review CHECK ((reviewed_at IS NULL) = (reviewed_by_admin_id IS NULL))
);
-- The same unresolved conflict is recorded once however often the update is redelivered.
CREATE UNIQUE INDEX group_migrations_open_conflict
  ON group_migrations (platform, from_chat_id, to_chat_id)
  WHERE status = 'conflict' AND reviewed_at IS NULL;
CREATE INDEX group_migrations_group_idx ON group_migrations (group_id, detected_at DESC);
