-- Daily group-activity reward with a per-group streak (2026-10-10). See docs/assumptions.md.

-- One row per (player, group, Tehran day) with at least one successful «لولو» there.
-- `streak` is the length of the run of consecutive days ending on that day; it is
-- fixed when the row is written (the previous day is already over by then).
CREATE TABLE streak_days (
  user_id      bigint  NOT NULL REFERENCES users (id),
  group_id     bigint  NOT NULL REFERENCES groups (id),
  tehran_date  date    NOT NULL,
  streak       integer NOT NULL CHECK (streak >= 1),
  PRIMARY KEY (user_id, group_id, tehran_date)
);
-- active members of a group on a day
CREATE INDEX streak_days_group_date_idx ON streak_days (group_id, tehran_date);

-- One payment per player per Tehran day, from one group only. The primary key makes a
-- second payment for the same day impossible, however often settlement runs.
CREATE TABLE streak_rewards (
  user_id          bigint         NOT NULL REFERENCES users (id),
  tehran_date      date           NOT NULL,
  group_id         bigint         NOT NULL REFERENCES groups (id),
  streak           integer        NOT NULL CHECK (streak >= 1),
  active_members   integer        NOT NULL CHECK (active_members >= 0),
  personal_centi   numeric(78, 0) NOT NULL CHECK (personal_centi >= 0),
  group_centi      numeric(78, 0) NOT NULL CHECK (group_centi >= 0),
  transaction_id   bigint REFERENCES transactions (id),
  created_at       timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tehran_date)
);

ALTER TABLE player_state
  -- Tehran day of the player's first successful «لولو» (for the account-age rule)
  ADD COLUMN first_lolo_date date,
  -- last Tehran day whose streak reward has been settled
  ADD COLUMN streak_settled_through date;

-- Existing players: their first lolo, from the ledger. Streaks themselves start now.
UPDATE player_state p
   SET first_lolo_date = f.first_day
  FROM (SELECT user_id, (min(effective_at) AT TIME ZONE 'Asia/Tehran')::date AS first_day
          FROM transactions WHERE kind = 'lolo_reward' AND user_id IS NOT NULL
         GROUP BY user_id) f
 WHERE f.user_id = p.user_id;

INSERT INTO wallets (kind, system_code) VALUES ('system', 'mint:streak');

-- Stored configuration documents get the new (suggested) section.
UPDATE config_versions
   SET config = config || '{"streak": {"baseReward": 10, "dailyIncrement": 5, "maxDays": 30,
                                       "groupRewardPerMember": 100, "groupMemberCap": 20,
                                       "minAccountAgeDays": 3}}'::jsonb
 WHERE NOT config ? 'streak';
