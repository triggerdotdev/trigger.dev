-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN IF NOT EXISTS plan_type LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN IF EXISTS plan_type;
