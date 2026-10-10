-- Owner rule changes after the first live test (2026-10-10). See docs/assumptions.md.

-- 1. «ترس» is removed from the game: every reward and every cost is in lolopoints.
ALTER TABLE player_state DROP COLUMN fear;

-- 2. Nothing is equipped by hand any more: the strongest owned tool is always the one
--    in use, derived from owned_tools and the configuration.
ALTER TABLE player_state DROP CONSTRAINT player_state_equipped_owned;
ALTER TABLE player_state DROP COLUMN equipped_tool;

-- 3. Food no longer feeds the «لولو» reward. Each meal pays a fixed number of points into
--    cash at the end of every interval it is active (6 × 5 minutes). The amount and the
--    schedule are copied from the configuration when the meal is eaten.
--    Meals eaten under the old rule were already paid through «لولو»; they are marked as
--    fully paid and simply run out.
ALTER TABLE food_effects
  ADD COLUMN deposit_centi            numeric(78, 0) NOT NULL DEFAULT 1,
  ADD COLUMN deposit_interval_seconds integer        NOT NULL DEFAULT 300,
  ADD COLUMN deposits_total           integer        NOT NULL DEFAULT 6,
  ADD COLUMN deposits_paid            integer        NOT NULL DEFAULT 6;
ALTER TABLE food_effects
  ALTER COLUMN deposit_centi DROP DEFAULT,
  ALTER COLUMN deposit_interval_seconds DROP DEFAULT,
  ALTER COLUMN deposits_total DROP DEFAULT,
  ALTER COLUMN deposits_paid SET DEFAULT 0,
  ADD CONSTRAINT food_effects_deposit_positive CHECK (deposit_centi > 0),
  ADD CONSTRAINT food_effects_interval_positive CHECK (deposit_interval_seconds > 0),
  ADD CONSTRAINT food_effects_deposits_range
    CHECK (deposits_total > 0 AND deposits_paid BETWEEN 0 AND deposits_total);
ALTER TABLE food_effects DROP COLUMN points_per_second;
-- meals that still owe deposits (settlement and the worker look for these)
CREATE INDEX food_effects_unpaid_idx ON food_effects (user_id, started_at)
  WHERE deposits_paid < deposits_total;

-- 4. Ghosts: a daily attempt counter, and a reward in points for every active member of
--    the group instead of fear for the finder. Open encounters keep their deadline and
--    get the new reward.
ALTER TABLE daily_ghost_state
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE ghost_encounters DROP COLUMN fear_reward;
ALTER TABLE ghost_encounters
  ADD COLUMN reward_per_member_centi numeric(78, 0) NOT NULL DEFAULT 5000
    CHECK (reward_per_member_centi > 0);
ALTER TABLE ghost_encounters ALTER COLUMN reward_per_member_centi DROP DEFAULT;

INSERT INTO wallets (kind, system_code) VALUES ('system', 'mint:ghost');

-- 5. Menu buttons (help, my cave, the shop's «buy» buttons…) never expire and can be used
--    again: they move no money, they only open a message. Confirmations keep their short
--    expiry and stay single-use. A NULL expiry marks a menu button. Earlier menu buttons
--    become usable again.
ALTER TABLE pending_confirmations ALTER COLUMN expires_at DROP NOT NULL;
UPDATE pending_confirmations
   SET expires_at = NULL, used_at = NULL
 WHERE action IN ('help', 'cave', 'prompt');

-- 6. Stored configuration documents take the new shape. These are owner rules, so they
--    replace the old values in every version; suggested values are kept.
UPDATE config_versions
   SET config = jsonb_set(
         jsonb_set(
           config,
           '{food}',
           ((config -> 'food') - 'pointsPerNutritionPerSecond' - 'claimWindowSeconds')
             || '{"depositIntervalSeconds": 300}'::jsonb
         ),
         '{ghosts}',
         ((config -> 'ghosts') - 'failureMultiplierBp' - 'fearMin' - 'fearMax')
           || '{"failureStepBp": 100, "dailyAttempts": 10, "cooldownSeconds": 600,
                "rewardPerMember": 50, "memberActivityWindowDays": 7,
                "replyDeadlineHours": 24}'::jsonb
       );
UPDATE config_versions
   SET config = jsonb_set(config, '{foods}', (
         SELECT jsonb_object_agg(f.key, f.value || jsonb_build_object('pointsPerDeposit', d.points))
           FROM jsonb_each(config -> 'foods') AS f(key, value)
           JOIN (VALUES ('bone', 3), ('mouse', 20), ('chicken', 70), ('pig', 150),
                        ('sheep', 270), ('cow', 360), ('deer', 500), ('human', 1000))
                AS d(food, points) ON d.food = f.key
       ));
