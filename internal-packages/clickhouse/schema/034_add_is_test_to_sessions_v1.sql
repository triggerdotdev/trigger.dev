-- +goose Up
-- Existing rows default to 0 and are intentionally NOT backfilled: the Sessions
-- list reads isTest from Postgres (ClickHouse only supplies session IDs), so the
-- UI is correct without it. A backfill is only needed if a ClickHouse-side
-- isTest filter/aggregate over sessions_v1 is added later.
ALTER TABLE trigger_dev.sessions_v1
  ADD COLUMN IF NOT EXISTS is_test UInt8 DEFAULT 0;

-- +goose Down
ALTER TABLE trigger_dev.sessions_v1
  DROP COLUMN IF EXISTS is_test;
