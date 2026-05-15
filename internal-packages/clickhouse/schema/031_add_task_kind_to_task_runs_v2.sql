-- +goose Up
-- IF NOT EXISTS is required because this migration was previously numbered
-- 029 and may have been applied in environments where goose accepted it
-- before 030_create_sessions_v1 advanced the version counter. Renaming to
-- 031 makes goose treat this as new everywhere, so the DDL must tolerate
-- the column already being present.
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN IF NOT EXISTS task_kind LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN IF EXISTS task_kind;
