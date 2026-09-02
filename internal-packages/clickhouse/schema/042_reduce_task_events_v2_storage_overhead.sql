-- +goose Up

-- Full-text search is served outside the source event table. Keeping these
-- indexes here adds work to every event insert and merge without serving reads.
-- attributes remains an insert input for attributes_text, but is no longer
-- stored. Writers must include attributes in an explicit insert column list
-- because implicit INSERT column lists exclude EPHEMERAL columns.
ALTER TABLE trigger_dev.task_events_v2
    DROP INDEX IF EXISTS idx_attributes_text_search,
    DROP INDEX IF EXISTS idx_message_text_search,
    MODIFY COLUMN attributes JSON EPHEMERAL;

-- +goose Down

-- Restoring the stored JSON column safely requires inspecting the live schema
-- and coordinating the writer rollback. Use a new forward migration instead.
SELECT throwIf(1, 'This migration cannot be rolled back automatically');
