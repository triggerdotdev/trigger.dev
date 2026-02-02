-- +goose Up

-- Add indexes for text search on task task_events_v2 tables for message and attributes fields
ALTER TABLE trigger_dev.task_events_v2
    ADD INDEX IF NOT EXISTS idx_attributes_text_search lower(attributes_text)
    TYPE ngrambf_v1(3, 32768, 2, 0)
    GRANULARITY 1;

ALTER TABLE trigger_dev.task_events_v2
    ADD INDEX IF NOT EXISTS idx_message_text_search lower(message)
    TYPE ngrambf_v1(3, 32768, 2, 0)
    GRANULARITY 1;

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
DROP INDEX idx_attributes_text_search;

ALTER TABLE trigger_dev.task_events_v2
DROP INDEX idx_message_text_search;
