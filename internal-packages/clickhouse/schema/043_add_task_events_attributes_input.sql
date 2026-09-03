-- +goose Up

ALTER TABLE trigger_dev.task_events_v2
    ADD COLUMN IF NOT EXISTS attributes_input JSON
        EPHEMERAL defaultValueOfTypeName('JSON')
        CODEC(ZSTD(1))
        AFTER attributes;

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
    DROP COLUMN IF EXISTS attributes_input;
