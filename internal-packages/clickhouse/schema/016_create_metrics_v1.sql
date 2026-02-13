-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.metrics_v1
(
  organization_id     LowCardinality(String),
  project_id          LowCardinality(String),
  environment_id      String,
  metric_name         LowCardinality(String),
  metric_type         LowCardinality(String),
  metric_subject      String,
  bucket_start        DateTime,
  count               UInt64 DEFAULT 0,
  sum_value           Float64 DEFAULT 0,
  max_value           Float64 DEFAULT 0,
  min_value           Float64 DEFAULT 0,
  last_value          Float64 DEFAULT 0,
  attributes          JSON(
    `trigger.run_id` String,
    `trigger.task_slug` String,
    `trigger.attempt_number` Int64,
    `trigger.environment_type` LowCardinality(String),
    `trigger.machine_id` String,
    `trigger.machine_name` LowCardinality(String),
    `trigger.worker_id` String,
    `trigger.worker_version` String,
    `system.cpu.logical_number` String,
    `system.cpu.state` LowCardinality(String),
    `system.memory.state` LowCardinality(String),
    `system.device` String,
    `process.cpu.state` LowCardinality(String),
    `network.io.direction` LowCardinality(String),
    max_dynamic_paths=8
  )
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, metric_name, metric_subject, bucket_start)
TTL bucket_start + INTERVAL 30 DAY;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.metrics_v1;
