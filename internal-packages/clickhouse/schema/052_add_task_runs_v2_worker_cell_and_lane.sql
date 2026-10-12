-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN IF NOT EXISTS worker_cell LowCardinality(String) DEFAULT '';

ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN IF NOT EXISTS worker_lane LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN IF EXISTS worker_cell;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN IF EXISTS worker_lane;
