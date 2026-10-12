-- Admin panel, step 8.2: service heartbeats and dashboard warning thresholds.

-- Each running bot and worker process reports here every 30 seconds, so the panel can
-- tell "running", "stopped" (clean shutdown) and "not responding" apart.
CREATE TABLE service_heartbeats (
  service       text        NOT NULL CHECK (service IN ('bot', 'worker')),
  -- host:pid:random, one row per process
  instance      text        NOT NULL,
  started_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  stopped_at    timestamptz,
  details       jsonb       NOT NULL DEFAULT '{}',
  PRIMARY KEY (service, instance)
);
CREATE INDEX service_heartbeats_seen_idx ON service_heartbeats (service, last_seen_at DESC);

-- Stored configuration documents get the new (suggested) monitoring section.
UPDATE config_versions
   SET config = config || '{"monitoring": {"inflationDailyWarnBp": 1000,
                                           "inflationWeeklyWarnBp": 3000,
                                           "inflationMinCirculation": 10000}}'::jsonb
 WHERE NOT config ? 'monitoring';

-- The approved panel plan sets the idle timeout to 30 minutes. Only the untouched code
-- default is rewritten; a value someone chose in the panel is kept.
UPDATE config_versions
   SET config = jsonb_set(config, '{admin,sessionIdleMinutes}', '30')
 WHERE source = 'default' AND config #> '{admin,sessionIdleMinutes}' = '120';
