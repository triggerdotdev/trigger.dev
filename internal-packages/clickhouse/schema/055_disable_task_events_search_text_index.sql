-- +goose Up

-- Retain the index definition without rebuilding it during normal merges.
ALTER TABLE trigger_dev.task_events_search_v2
    MODIFY SETTING exclude_materialize_skip_indexes_on_merge = 'idx_search_text';

-- +goose Down

ALTER TABLE trigger_dev.task_events_search_v2
    RESET SETTING exclude_materialize_skip_indexes_on_merge;
