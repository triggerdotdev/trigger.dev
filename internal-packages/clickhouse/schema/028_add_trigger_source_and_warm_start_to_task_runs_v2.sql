-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN trigger_source LowCardinality(String) DEFAULT '';

ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN root_trigger_source LowCardinality(String) DEFAULT '';

ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN is_warm_start Nullable(UInt8) DEFAULT NULL;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN trigger_source;

ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN root_trigger_source;

ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN is_warm_start;
