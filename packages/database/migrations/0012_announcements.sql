-- Admin panel, step 8.7: announcements to every group or to one group. Each recipient is
-- an ordinary outbox row, so the existing sender applies the platform rate limits and
-- retry_after; the rows stay linked to their announcement for its delivery status.
CREATE TABLE announcements (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text                   text        NOT NULL CHECK (length(btrim(text)) > 0),
  target                 text        NOT NULL CHECK (target IN ('all_groups', 'group')),
  group_id               bigint REFERENCES groups (id),
  silent                 boolean     NOT NULL DEFAULT false,
  recipients             integer     NOT NULL CHECK (recipients >= 0),
  created_by_admin_id    bigint      NOT NULL REFERENCES admin_users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  cancelled_at           timestamptz,
  cancelled_by_admin_id  bigint REFERENCES admin_users (id),
  CHECK ((target = 'group') = (group_id IS NOT NULL))
);
CREATE INDEX announcements_created_idx ON announcements (created_at DESC, id DESC);

ALTER TABLE outbox ADD COLUMN announcement_id bigint REFERENCES announcements (id);
CREATE INDEX outbox_announcement_idx ON outbox (announcement_id) WHERE announcement_id IS NOT NULL;

-- A pending announcement message can be cancelled; the sender only picks 'pending'.
ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'sent', 'dead', 'cancelled'));
