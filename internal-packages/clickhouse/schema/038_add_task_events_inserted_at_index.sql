-- +goose Up
-- Source index supporting closed projector windows on newly written parts.
-- ADD INDEX only defines the index for new parts and does not materialize existing parts.
ALTER TABLE trigger_dev.task_events_v2
  ADD INDEX IF NOT EXISTS idx_inserted_at_projector inserted_at TYPE minmax GRANULARITY 1;

-- +goose Down
ALTER TABLE trigger_dev.task_events_v2
  DROP INDEX IF EXISTS idx_inserted_at_projector;
