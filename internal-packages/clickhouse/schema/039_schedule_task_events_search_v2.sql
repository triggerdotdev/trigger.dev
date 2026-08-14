-- +goose Up
-- Move v2 projection outside the task_events_v2 insert path. The replacement table
-- collapses exact retry copies during merges, while reads hide copies still awaiting a merge.
DROP VIEW IF EXISTS trigger_dev.task_events_search_mv_v2;

-- This index is available on new parts. Historical backfill stays separately disabled
-- until operators have prepared and validated the older source partitions they will scan.
ALTER TABLE trigger_dev.task_events_v2
  ADD INDEX IF NOT EXISTS idx_inserted_at_projector inserted_at TYPE minmax GRANULARITY 1;

CREATE TABLE trigger_dev.task_events_search_v2_projector
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
  projection_fingerprint FixedString(16) DEFAULT sipHash128(
    trace_id,
    span_id,
    run_id,
    start_time
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

-- Keep the insert-triggered table until its TTL expires so the switch does not require
-- a large copy or mutation. All v2 reads and scheduled writes use the replacement.
RENAME TABLE
  trigger_dev.task_events_search_v2 TO trigger_dev.task_events_search_v2_insert_triggered,
  trigger_dev.task_events_search_v2_projector TO trigger_dev.task_events_search_v2;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.task_events_search_v2_projector_rollback;

RENAME TABLE
  trigger_dev.task_events_search_v2 TO trigger_dev.task_events_search_v2_projector_rollback,
  trigger_dev.task_events_search_v2_insert_triggered TO trigger_dev.task_events_search_v2;

DROP TABLE IF EXISTS trigger_dev.task_events_search_v2_projector_rollback;

ALTER TABLE trigger_dev.task_events_v2
  DROP INDEX IF EXISTS idx_inserted_at_projector;

CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.task_events_search_mv_v2
TO trigger_dev.task_events_search_v2 AS
SELECT
  environment_id,
  organization_id,
  project_id,
  least(
    fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)),
    now64(9) + INTERVAL 5 MINUTE
  ) AS triggered_timestamp,
  trace_id,
  span_id,
  run_id,
  task_identifier,
  start_time,
  inserted_at,
  message,
  substring(JSONExtractString(attributes_text, 'error', 'message'), 1, 2048) AS error_message,
  replaceRegexpAll(
    lowerUTF8(
      substring(
        concat(
          substring(message, 1, 2048),
          ' ',
          replaceAll(substring(attributes_text, 1, 6144), '\\/', '/')
        ),
        1,
        8192
      )
    ),
    '[^\\p{L}\\p{N}_./:@+-]+',
    ' '
  ) AS search_text,
  kind,
  status,
  duration,
  parent_span_id
FROM trigger_dev.task_events_v2
WHERE
  trace_id != ''
  AND kind != 'DEBUG_EVENT'
  AND status != 'PARTIAL'
  AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
  AND kind != 'ANCESTOR_OVERRIDE'
  AND message != 'trigger.dev/start';
