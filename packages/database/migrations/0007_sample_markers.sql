-- Sample data for the admin panel's development mode (`npm run dev:panel`).
-- Sample players and groups carry a database flag as well as the «[نمونه]» name prefix,
-- so they can never be mistaken for real ones. Production never loads sample data; the
-- seeder refuses to run on a database that has real players or groups.

ALTER TABLE users ADD COLUMN is_sample boolean NOT NULL DEFAULT false;
ALTER TABLE groups ADD COLUMN is_sample boolean NOT NULL DEFAULT false;
