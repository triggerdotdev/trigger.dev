-- +goose Up
-- Create materialized views for task_events_v2 table (partitioned by inserted_at)
-- These write to the same target tables as the v1 MVs so usage is aggregated across both tables

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.mv_task_event_v2_usage_by_minute
TO trigger_dev.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM trigger_dev.task_events_v2
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.mv_task_event_v2_usage_by_minute;

