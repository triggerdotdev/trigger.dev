-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN task_kind LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN task_kind;
