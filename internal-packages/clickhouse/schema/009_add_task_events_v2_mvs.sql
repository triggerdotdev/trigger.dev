-- +goose Up
DROP TABLE IF EXISTS trigger_dev.mv_task_event_usage_by_minute_v1;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.mv_task_event_usage_by_minute_v2
TO trigger_dev.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM trigger_dev.task_events_v1
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;


-- +goose Down
DROP TABLE IF EXISTS trigger_dev.mv_task_event_usage_by_minute_v2;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.mv_task_event_usage_by_minute_v1
TO trigger_dev.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM trigger_dev.task_events_v1
GROUP BY organization_id, project_id, environment_id, bucket_start;
