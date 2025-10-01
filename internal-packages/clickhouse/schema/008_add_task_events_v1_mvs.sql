-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.task_event_usage_by_minute_v1
(
  organization_id String,
  project_id String,
  environment_id String,
  bucket_start DateTime,
  event_count UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, bucket_start)
TTL bucket_start + INTERVAL 8 DAY;

CREATE TABLE IF NOT EXISTS trigger_dev.task_event_usage_by_hour_v1
(
  organization_id String,
  project_id String,
  environment_id String,
  bucket_start DateTime,
  event_count UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, bucket_start)
TTL bucket_start + INTERVAL 400 DAY;

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

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.mv_task_event_usage_by_hour_v1
TO trigger_dev.task_event_usage_by_hour_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfHour(bucket_start) AS bucket_start,
  sum(event_count) AS event_count
FROM trigger_dev.task_event_usage_by_minute_v1
GROUP BY organization_id, project_id, environment_id, bucket_start;


-- +goose Down
DROP TABLE IF EXISTS trigger_dev.task_event_usage_by_hour_v1;
DROP TABLE IF EXISTS trigger_dev.task_event_usage_by_minute_v1;
DROP MATERIALIZED VIEW IF EXISTS trigger_dev.mv_task_event_usage_by_minute_v1;
DROP MATERIALIZED VIEW IF EXISTS trigger_dev.mv_task_event_usage_by_hour_v1;