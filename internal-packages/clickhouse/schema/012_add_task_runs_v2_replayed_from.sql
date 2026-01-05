-- +goose Up
/*
Add replayed_from_friendly_id column to track which run this was replayed from.
 */
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN replayed_from_friendly_id String DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN replayed_from_friendly_id;
