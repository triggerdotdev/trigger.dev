-- +goose Up
-- Minmax skip index on completed_at for completion-time run filters.
-- Metadata-only: covers new parts only (no MATERIALIZE).
ALTER TABLE trigger_dev.task_runs_v2
  ADD INDEX IF NOT EXISTS idx_completed_at completed_at TYPE minmax GRANULARITY 1;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP INDEX IF EXISTS idx_completed_at;
