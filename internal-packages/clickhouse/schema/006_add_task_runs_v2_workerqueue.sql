-- +goose Up
/*
Add worker_queue column.
 */
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN worker_queue String DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN worker_queue;