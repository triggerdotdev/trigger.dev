-- +goose Up

-- Metadata-only change. attributes_text moves from MATERIALIZED to DEFAULT so a
-- writer may supply the serialized attributes itself. A writer that omits the
-- column still gets toJSONString(attributes), exactly as before, so old and new
-- writers can coexist against the same table.
ALTER TABLE trigger_dev.task_events_v2
    MODIFY COLUMN IF EXISTS attributes_text String
        DEFAULT toJSONString(attributes);

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
    MODIFY COLUMN IF EXISTS attributes_text String
        MATERIALIZED toJSONString(attributes);
