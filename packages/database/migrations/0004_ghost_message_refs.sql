-- Extra messages that show an existing ghost encounter. After a group is migrated to a
-- supergroup, replies to messages posted in the old (basic) group cannot always be
-- identified (Telegram's external_reply carries the original chat and message id only
-- for supergroups and channels), so open ghosts are re-posted in the new chat and the
-- new message is linked here. «شنیدم» on any linked message answers the same encounter,
-- still once only.
CREATE TABLE ghost_message_refs (
  platform      text        NOT NULL CHECK (platform IN ('telegram', 'rubika')),
  chat_id       text        NOT NULL,
  message_id    text        NOT NULL,
  encounter_id  bigint      NOT NULL REFERENCES ghost_encounters (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, chat_id, message_id)
);
CREATE INDEX ghost_message_refs_encounter_idx ON ghost_message_refs (encounter_id);
