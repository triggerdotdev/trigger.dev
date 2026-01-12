-- +goose Up

-- Add user-provided idempotency key and scope columns to task_runs_v2
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN user_idempotency_key String DEFAULT '';

ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN idempotency_key_scope LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN IF EXISTS user_idempotency_key;

ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN IF EXISTS idempotency_key_scope;
