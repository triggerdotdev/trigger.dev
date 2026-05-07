-- +goose Up
-- We drop the existing MV and recreate it with the new filter condition
DROP VIEW IF EXISTS trigger_dev.task_events_search_mv_v1;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.task_events_search_mv_v1
TO trigger_dev.task_events_search_v1 AS
SELECT
    environment_id,
    organization_id,
    project_id,
    trace_id,
    span_id,
    run_id,
    task_identifier,
    start_time,
    inserted_at,
    message,
    kind,
    status,
    duration,
    parent_span_id,
    attributes_text,
    fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)) AS triggered_timestamp
FROM trigger_dev.task_events_v2
WHERE
    trace_id != '' -- New condition added here
    AND kind != 'DEBUG_EVENT'
    AND status != 'PARTIAL'
    AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
    AND kind != 'ANCESTOR_OVERRIDE'
    AND message != 'trigger.dev/start';

-- +goose Down
-- In the down migration, we revert to the previous filter set
DROP VIEW IF EXISTS trigger_dev.task_events_search_mv_v1;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.task_events_search_mv_v1
TO trigger_dev.task_events_search_v1 AS
SELECT
    environment_id,
    organization_id,
    project_id,
    trace_id,
    span_id,
    run_id,
    task_identifier,
    start_time,
    inserted_at,
    message,
    kind,
    status,
    duration,
    parent_span_id,
    attributes_text,
    fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)) AS triggered_timestamp
FROM trigger_dev.task_events_v2
WHERE
    kind != 'DEBUG_EVENT'
    AND status != 'PARTIAL'
    AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
    AND kind != 'ANCESTOR_OVERRIDE'
    AND message != 'trigger.dev/start';