-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.metrics_v1
(
  organization_id     LowCardinality(String),
  project_id          LowCardinality(String),
  environment_id      String CODEC(ZSTD(1)),
  metric_name         LowCardinality(String),
  metric_type         LowCardinality(String),
  metric_subject      String CODEC(ZSTD(1)),
  bucket_start        DateTime CODEC(Delta(4), ZSTD(1)),
  value               Float64 DEFAULT 0 CODEC(ZSTD(1)),
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
    `system.filesystem.type` LowCardinality(String),
    `system.filesystem.mountpoint` String,
    `system.filesystem.mode` LowCardinality(String),
    `system.filesystem.state` LowCardinality(String),
    `disk.io.direction` LowCardinality(String),
    `process.cpu.state` LowCardinality(String),
    `network.io.direction` LowCardinality(String),
    max_dynamic_paths=8
  ),
  INDEX idx_run_id attributes.trigger.run_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_task_slug attributes.trigger.task_slug TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY toDate(bucket_start)
ORDER BY (organization_id, project_id, environment_id, metric_name, metric_subject, bucket_start)
TTL bucket_start + INTERVAL 60 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.metrics_v1;
