-- +goose Up

-- Full-text search is served outside the source event table. Keeping these
-- indexes here adds work to every event insert and merge without serving reads.
ALTER TABLE trigger_dev.task_events_v2
    DROP INDEX IF EXISTS idx_attributes_text_search,
    DROP INDEX IF EXISTS idx_attributes_text,
    DROP INDEX IF EXISTS idx_message_text_search,
    DROP INDEX IF EXISTS message_text_search
SETTINGS mutations_sync = 2, alter_sync = 2;

-- +goose Down

-- Restoring these indexes safely requires selecting the appropriate index
-- definitions and materializing them in a new forward migration.
SELECT throwIf(1, 'This migration cannot be rolled back automatically');
