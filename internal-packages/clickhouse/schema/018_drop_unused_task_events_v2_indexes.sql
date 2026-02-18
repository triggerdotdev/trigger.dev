-- +goose Up

-- These indexes are not used in any WHERE clause.
-- idx_duration: duration is only written/read as a column, never filtered on.
-- idx_attributes_text: search queries use the task_events_search_v1 table instead.
ALTER TABLE trigger_dev.task_events_v2
    DROP INDEX IF EXISTS idx_duration;

ALTER TABLE trigger_dev.task_events_v2
    DROP INDEX IF EXISTS idx_attributes_text;

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
    ADD INDEX IF NOT EXISTS idx_duration duration
    TYPE minmax
    GRANULARITY 1;

ALTER TABLE trigger_dev.task_events_v2
    ADD INDEX IF NOT EXISTS idx_attributes_text attributes_text
    TYPE tokenbf_v1(32768, 3, 0)
    GRANULARITY 8;
