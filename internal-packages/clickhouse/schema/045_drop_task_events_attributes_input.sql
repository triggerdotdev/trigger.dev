-- +goose Up

-- Every writer now supplies attributes_text directly, so the DEFAULT bridge and
-- the ephemeral attributes_input column it replaced are no longer needed. Both
-- statements are metadata-only. Apply only once no writer relies on the
-- computed default.
ALTER TABLE trigger_dev.task_events_v2
    MODIFY COLUMN IF EXISTS attributes_text REMOVE DEFAULT;

ALTER TABLE trigger_dev.task_events_v2
    DROP COLUMN IF EXISTS attributes_input;

-- +goose Down

ALTER TABLE trigger_dev.task_events_v2
    ADD COLUMN IF NOT EXISTS attributes_input JSON
        EPHEMERAL defaultValueOfTypeName('JSON')
        CODEC(ZSTD(1))
        AFTER attributes;

ALTER TABLE trigger_dev.task_events_v2
    MODIFY COLUMN IF EXISTS attributes_text String
        DEFAULT toJSONString(attributes);
