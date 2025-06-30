-- +goose Up
/*
Add concurrency_key and bulk_action_group_ids columns with defaults.
 */
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN concurrency_key String DEFAULT '',
ADD COLUMN bulk_action_group_ids Array(String) DEFAULT [];

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN concurrency_key,
DROP COLUMN bulk_action_group_ids;