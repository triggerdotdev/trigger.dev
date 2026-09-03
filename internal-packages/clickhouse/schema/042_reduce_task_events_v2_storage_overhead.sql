-- +goose Up

ALTER TABLE trigger_dev.task_events_v2
    DROP INDEX IF EXISTS idx_attributes_text_search,
    DROP INDEX IF EXISTS idx_attributes_text,
    DROP INDEX IF EXISTS idx_message_text_search,
    DROP INDEX IF EXISTS message_text_search;

-- +goose Down
