-- +goose Up
/*
Add max_duration_in_seconds column.
 */
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN max_duration_in_seconds Nullable (UInt32) DEFAULT NULL;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN max_duration_in_seconds;