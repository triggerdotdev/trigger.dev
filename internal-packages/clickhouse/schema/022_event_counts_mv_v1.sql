-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.event_counts_v1
(
    project_id String,
    environment_id String,
    event_type String,
    bucket_start DateTime,
    event_count UInt64,
    total_fan_out UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (project_id, environment_id, event_type, bucket_start)
TTL bucket_start + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.event_counts_mv_v1
TO trigger_dev.event_counts_v1 AS
SELECT
    project_id,
    environment_id,
    event_type,
    toStartOfMinute(published_at) AS bucket_start,
    count() AS event_count,
    sum(fan_out_count) AS total_fan_out
FROM trigger_dev.event_log_v1
GROUP BY project_id, environment_id, event_type, bucket_start;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.event_counts_mv_v1;
DROP TABLE IF EXISTS trigger_dev.event_counts_v1;
