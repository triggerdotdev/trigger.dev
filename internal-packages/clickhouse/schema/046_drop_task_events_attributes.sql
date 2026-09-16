-- +goose Up

-- Writers stopped populating attributes several releases ago. Apply once the
-- table's TTL has aged out the stored values, so nothing readable is lost.
-- Metadata-only. The parts are rewritten by normal merges.
ALTER TABLE trigger_dev.task_events_v2
    DROP COLUMN IF EXISTS attributes;

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
    ADD COLUMN IF NOT EXISTS attributes JSON CODEC(ZSTD(1))
        AFTER status;
