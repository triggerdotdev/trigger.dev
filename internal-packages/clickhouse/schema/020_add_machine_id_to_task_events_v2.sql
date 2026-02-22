-- +goose Up
ALTER TABLE trigger_dev.task_events_v2
ADD COLUMN machine_id String DEFAULT '' CODEC(ZSTD(1));

-- +goose Down
ALTER TABLE trigger_dev.task_events_v2
DROP COLUMN machine_id;
