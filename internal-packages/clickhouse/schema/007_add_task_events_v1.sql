-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.task_events_v1
(
  -- This the main "tenant" ID
  environment_id String,
  -- The organization ID here so we can do MV rollups of usage
  organization_id String,
  -- The project ID here so we can do MV rollups of usage
  project_id String,
  -- The task slug (e.g. "my-task")
  task_identifier String CODEC(ZSTD(1)),
  -- The non-friendly ID for the run
  run_id String CODEC(ZSTD(1)),
  -- nanoseconds since the epoch
  start_time DateTime64(9) CODEC(Delta(8), ZSTD(1)),
  trace_id   String CODEC(ZSTD(1)),
  span_id    String CODEC(ZSTD(1)),
  -- will be an empty string for root spans
  parent_span_id String CODEC(ZSTD(1)),
  -- Log body, event name, or span name
  message String CODEC(ZSTD(1)),
  -- this is the new level column, can be
  -- SPAN, SPAN_EVENT, DEBUG_EVENT, LOG_DEBUG, LOG_LOG, LOG_SUCCESS, LOG_INFO, LOG_WARN, LOG_ERROR, ANCESTOR_OVERRIDE
  kind LowCardinality(String) CODEC(ZSTD(1)),
  -- isError, isPartial, isCancelled will now be in this status column
  -- OK, ERROR, PARTIAL, CANCELLED
  status LowCardinality(String) CODEC(ZSTD(1)),
  -- span/log/event attributes and resource attributes
  -- includes error attributes, gen_ai attributes, and other attributes
  attributes JSON CODEC(ZSTD(1)),
  attributes_text String MATERIALIZED toJSONString(attributes),
  -- This is the metadata column, includes style for styling the event in the UI
  -- is a JSON stringified object, e.g. {"style":{"icon":"play","variant":"primary"},"error":{"message":"Error message","attributes":{"error.type":"ErrorType","error.code":"123"}}}
  metadata String CODEC(ZSTD(1)),
  -- nanoseconds since the start time, only non-zero for spans
  duration UInt64 CODEC(ZSTD(1)),
  -- The TTL for the event, will be deleted 7 days after the event expires
  expires_at DateTime64(3),

  INDEX idx_run_id run_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_span_id span_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_duration duration TYPE minmax GRANULARITY 1,
  INDEX idx_attributes_text attributes_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(start_time)
ORDER BY (environment_id, toUnixTimestamp(start_time), trace_id)
TTL toDateTime(expires_at) + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.task_events_v1;