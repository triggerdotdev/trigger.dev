-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN IF NOT EXISTS queue_timestamp Nullable(DateTime64(3)) AFTER created_at;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN IF EXISTS queue_timestamp;
