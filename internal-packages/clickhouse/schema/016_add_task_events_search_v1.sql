-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.task_events_search_v1
(
  environment_id String,
  organization_id String,
  project_id String,
  triggered_timestamp DateTime64(9) CODEC(Delta(8), ZSTD(1)),
  trace_id String CODEC(ZSTD(1)),
  span_id String CODEC(ZSTD(1)),
  run_id String CODEC(ZSTD(1)),
  task_identifier String CODEC(ZSTD(1)),
  start_time DateTime64(9) CODEC(Delta(8), ZSTD(1)),
  inserted_at DateTime64(3),
  message String CODEC(ZSTD(1)),
  kind LowCardinality(String) CODEC(ZSTD(1)),
  status LowCardinality(String) CODEC(ZSTD(1)),
  duration UInt64 CODEC(ZSTD(1)),
  parent_span_id String CODEC(ZSTD(1)),
  attributes_text String CODEC(ZSTD(1)),

  INDEX idx_run_id run_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_message_text_search lower(message) TYPE ngrambf_v1(3, 32768, 2, 0) GRANULARITY 1,
  INDEX idx_attributes_text_search lower(attributes_text) TYPE ngrambf_v1(3, 32768, 2, 0) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(triggered_timestamp)
ORDER BY (organization_id, environment_id, triggered_timestamp, span_id)
--Right now we have maximum retention of up to 30 days based on plan.
--We put a logical limit for now, the 90 DAY TTL is just a backup
--This might need to be updated for longer retention periods
TTL toDateTime(triggered_timestamp) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

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
  toJSONString(attributes) AS attributes_text,
  fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)) AS triggered_timestamp
FROM trigger_dev.task_events_v2
WHERE
    kind != 'DEBUG_EVENT'
    AND status != 'PARTIAL'
    AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
    AND kind != 'ANCESTOR_OVERRIDE'
    AND message != 'trigger.dev/start';

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.task_events_search_mv_v1;
DROP TABLE IF EXISTS trigger_dev.task_events_search_v1;
