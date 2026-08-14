-- +goose Up
-- Search v2 stores bounded normalized text outside the task_events_v2 insert path.
-- The source index supports closed projector windows on newly written parts.
ALTER TABLE trigger_dev.task_events_v2
  ADD INDEX IF NOT EXISTS idx_inserted_at_projector inserted_at TYPE minmax GRANULARITY 1;

CREATE TABLE IF NOT EXISTS trigger_dev.task_events_search_v2
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
  error_message String CODEC(ZSTD(1)),
  search_text String CODEC(ZSTD(1)),
  kind LowCardinality(String) CODEC(ZSTD(1)),
  status LowCardinality(String) CODEC(ZSTD(1)),
  duration UInt64 CODEC(ZSTD(1)),
  parent_span_id String CODEC(ZSTD(1)),
  projection_fingerprint UInt128 DEFAULT reinterpretAsUInt128(
    sipHash128(trace_id, span_id, run_id, start_time)
  ),

  INDEX idx_run_id run_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_search_text search_text
    TYPE text(tokenizer = 'ngrams', preprocessor = lowerUTF8(search_text))
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(triggered_timestamp)
ORDER BY (
  organization_id,
  environment_id,
  triggered_timestamp,
  trace_id,
  span_id,
  projection_fingerprint
)
TTL toDateTime(triggered_timestamp) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.task_events_search_v2;

ALTER TABLE trigger_dev.task_events_v2
  DROP INDEX IF EXISTS idx_inserted_at_projector;
