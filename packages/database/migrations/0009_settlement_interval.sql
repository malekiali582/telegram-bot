-- The worker's periodic settlement of idle accounts runs hourly instead of every minute
-- (owner's choice, 2026-10-12): far fewer cemetery_income and food_income rows, the
-- same amounts. The interval is a suggested configuration value. Existing ledger rows
-- are untouched.
UPDATE config_versions
   SET config = config || '{"settlement": {"periodicIntervalMinutes": 60}}'::jsonb
 WHERE NOT config ? 'settlement';
