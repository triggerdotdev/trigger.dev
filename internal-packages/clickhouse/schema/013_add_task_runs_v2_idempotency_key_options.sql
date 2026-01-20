-- +goose Up

-- Add columns for storing user-provided idempotency key and scope for searching
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN idempotency_key_user String DEFAULT '';

ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN idempotency_key_scope String DEFAULT '';

-- +goose Down

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN idempotency_key_user;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN idempotency_key_scope;
