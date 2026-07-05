-- +goose Up

-- Queue metrics: raw landing table -> MV -> aggregated read target (mirrors
-- llm_model_aggregates_v1, migration 027). Raw rows feed an MV on insert, and
-- reads hit the aggregated table.

-- Short-TTL raw landing, one row per stream entry. non_replicated_deduplication_window
-- makes consumer replays idempotent via insert_deduplication_token.
CREATE TABLE IF NOT EXISTS trigger_dev.queue_metrics_raw_v1
(
  organization_id  LowCardinality(String),
  project_id       LowCardinality(String),
  environment_id   String CODEC(ZSTD(1)),
  queue_name       String CODEC(ZSTD(1)),
  concurrency_key  String DEFAULT '' CODEC(ZSTD(1)),  -- per-key attribution ('' = base/whole-queue row)
  event_time       DateTime CODEC(Delta(4), ZSTD(1)),
  order_key        UInt64 DEFAULT 0,                 -- stream-id composite (ms*1e6+seq), deltaSumTimestamp ordering key
  op               LowCardinality(String),          -- gauge | enqueue | started | ack | nack | dlq
  running          UInt32 DEFAULT 0,
  queued           UInt32 DEFAULT 0,
  queue_limit      UInt32 DEFAULT 0,
  env_running      UInt32 DEFAULT 0,
  env_queued       UInt32 DEFAULT 0,
  env_limit        UInt32 DEFAULT 0,
  throttled        UInt8  DEFAULT 0,                 -- 1 on a gauge emission with running>=limit AND queued>0
  ck_backlogged    UInt32 DEFAULT 0,                 -- gauge on CK queues: distinct concurrency keys with queued work
  ck_max_wait_ms   UInt32 DEFAULT 0,                 -- gauge on CK queues: most-starved key's head-of-line wait
  wait_ms          UInt32 DEFAULT 0,                 -- set on op='started' (scheduling delay)
  cumulative       UInt64 DEFAULT 0                  -- monotonic per-(queue,op) odometer on a counter op, diffed at read time
)
ENGINE = MergeTree()
PARTITION BY toDate(event_time)
ORDER BY (organization_id, project_id, environment_id, queue_name, event_time)
TTL event_time + INTERVAL 6 HOUR
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;

-- (2) Aggregated read target (TRQL/dashboards query this).
CREATE TABLE IF NOT EXISTS trigger_dev.queue_metrics_v1
(
  organization_id  LowCardinality(String),
  project_id       LowCardinality(String),
  environment_id   String CODEC(ZSTD(1)),
  queue_name       String CODEC(ZSTD(1)),
  bucket_start     DateTime CODEC(Delta(4), ZSTD(1)),

  -- Cumulative-counter deltas: each op maintains a monotonic odometer, and deltaSumTimestamp
  -- sums positive consecutive deltas (ignoring resets) ordered by event_time, so a lost
  -- reading self-heals (the next surviving reading restates the total). Read with
  -- deltaSumTimestampMerge(<col>), never sum().
  enqueue_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  started_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  ack_delta        AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  nack_delta       AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  dlq_delta        AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  throttled_count  SimpleAggregateFunction(sum, UInt64),

  max_queued       SimpleAggregateFunction(max, UInt32),
  max_running      SimpleAggregateFunction(max, UInt32),
  max_limit        SimpleAggregateFunction(max, UInt32),
  max_env_queued   SimpleAggregateFunction(max, UInt32),
  max_env_running  SimpleAggregateFunction(max, UInt32),
  max_env_limit    SimpleAggregateFunction(max, UInt32),
  max_ck_backlogged SimpleAggregateFunction(max, UInt32),
  max_ck_wait_ms   SimpleAggregateFunction(max, UInt32),

  wait_ms_sum      SimpleAggregateFunction(sum, UInt64),
  wait_ms_count    SimpleAggregateFunction(sum, UInt64),
  wait_quantiles   AggregateFunction(quantiles(0.5, 0.9, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, bucket_start)
TTL bucket_start + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000;

-- (3) MV: raw -> aggregated, 10s buckets.
CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.queue_metrics_mv_v1
TO trigger_dev.queue_metrics_v1 AS
SELECT
  organization_id, project_id, environment_id, queue_name,
  toStartOfInterval(event_time, INTERVAL 10 SECOND) AS bucket_start,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'enqueue' AND concurrency_key = '') AS enqueue_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'started' AND concurrency_key = '') AS started_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'ack' AND concurrency_key = '')     AS ack_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'nack' AND concurrency_key = '')    AS nack_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'dlq' AND concurrency_key = '')     AS dlq_delta,
  sum(throttled)          AS throttled_count,
  max(queued)             AS max_queued,
  max(running)            AS max_running,
  max(queue_limit)        AS max_limit,
  max(env_queued)         AS max_env_queued,
  max(env_running)        AS max_env_running,
  max(env_limit)          AS max_env_limit,
  max(ck_backlogged)      AS max_ck_backlogged,
  max(ck_max_wait_ms)     AS max_ck_wait_ms,
  sumIf(wait_ms, op = 'started' AND concurrency_key = '')                 AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0 AND concurrency_key = '')        AS wait_ms_count,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(wait_ms, op = 'started' AND wait_ms > 0 AND concurrency_key = '') AS wait_quantiles
FROM trigger_dev.queue_metrics_raw_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;

-- (4) Env-level 10s rollup (no queue dimension) for header tiles/saturation charts.
-- Row count is queue-independent (~8640/day/env), so full granularity stays cheap at any range.
-- No counter deltas on purpose: cross-queue deltaSumTimestamp state merges mix unrelated
-- odometers (env totals must GROUP BY queue then sum). TDigest because an env-level
-- reservoir absorbs every sample in the environment.
CREATE TABLE IF NOT EXISTS trigger_dev.env_metrics_v1
(
  organization_id  LowCardinality(String),
  project_id       LowCardinality(String),
  environment_id   String CODEC(ZSTD(1)),
  bucket_start     DateTime CODEC(Delta(4), ZSTD(1)),

  max_env_queued   SimpleAggregateFunction(max, UInt32),
  max_env_running  SimpleAggregateFunction(max, UInt32),
  max_env_limit    SimpleAggregateFunction(max, UInt32),
  throttled_count  SimpleAggregateFunction(sum, UInt64),

  wait_ms_sum      SimpleAggregateFunction(sum, UInt64),
  wait_ms_count    SimpleAggregateFunction(sum, UInt64),
  wait_quantiles   AggregateFunction(quantilesTDigest(0.5, 0.9, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket_start)
ORDER BY (organization_id, project_id, environment_id, bucket_start)
TTL bucket_start + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000;

-- (5) MV: raw -> env rollup.
CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.env_metrics_mv_v1
TO trigger_dev.env_metrics_v1 AS
SELECT
  organization_id, project_id, environment_id,
  toStartOfInterval(event_time, INTERVAL 10 SECOND) AS bucket_start,
  max(env_queued)         AS max_env_queued,
  max(env_running)        AS max_env_running,
  max(env_limit)          AS max_env_limit,
  sum(throttled)          AS throttled_count,
  sumIf(wait_ms, op = 'started' AND concurrency_key = '')                 AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0 AND concurrency_key = '')        AS wait_ms_count,
  quantilesTDigestStateIf(0.5, 0.9, 0.95, 0.99)(wait_ms, op = 'started' AND wait_ms > 0 AND concurrency_key = '') AS wait_quantiles
FROM trigger_dev.queue_metrics_raw_v1
GROUP BY organization_id, project_id, environment_id, bucket_start;

-- (6) Per-queue 5m rollup, exact column mirror of queue_metrics_v1, for ranking and
-- env-wide GROUP BY queue reads at long ranges.
CREATE TABLE IF NOT EXISTS trigger_dev.queue_metrics_5m_v1
(
  organization_id  LowCardinality(String),
  project_id       LowCardinality(String),
  environment_id   String CODEC(ZSTD(1)),
  queue_name       String CODEC(ZSTD(1)),
  bucket_start     DateTime CODEC(Delta(4), ZSTD(1)),

  enqueue_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  started_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  ack_delta        AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  nack_delta       AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  dlq_delta        AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  throttled_count  SimpleAggregateFunction(sum, UInt64),

  max_queued       SimpleAggregateFunction(max, UInt32),
  max_running      SimpleAggregateFunction(max, UInt32),
  max_limit        SimpleAggregateFunction(max, UInt32),
  max_env_queued   SimpleAggregateFunction(max, UInt32),
  max_env_running  SimpleAggregateFunction(max, UInt32),
  max_env_limit    SimpleAggregateFunction(max, UInt32),
  max_ck_backlogged SimpleAggregateFunction(max, UInt32),
  max_ck_wait_ms   SimpleAggregateFunction(max, UInt32),

  wait_ms_sum      SimpleAggregateFunction(sum, UInt64),
  wait_ms_count    SimpleAggregateFunction(sum, UInt64),
  wait_quantiles   AggregateFunction(quantiles(0.5, 0.9, 0.95, 0.99), UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, bucket_start)
TTL bucket_start + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000;

-- (7) MV: raw -> 5m rollup. MUST read raw, never cascade off queue_metrics_v1 with
-- -MergeState: MV GROUP BY merges states in hash order, and out-of-time-order
-- deltaSumTimestamp merges double-count bridging spans (verified 3x inflation).
CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.queue_metrics_5m_mv_v1
TO trigger_dev.queue_metrics_5m_v1 AS
SELECT
  organization_id, project_id, environment_id, queue_name,
  toStartOfInterval(event_time, INTERVAL 5 MINUTE) AS bucket_start,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'enqueue' AND concurrency_key = '') AS enqueue_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'started' AND concurrency_key = '') AS started_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'ack' AND concurrency_key = '')     AS ack_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'nack' AND concurrency_key = '')    AS nack_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'dlq' AND concurrency_key = '')     AS dlq_delta,
  sum(throttled)          AS throttled_count,
  max(queued)             AS max_queued,
  max(running)            AS max_running,
  max(queue_limit)        AS max_limit,
  max(env_queued)         AS max_env_queued,
  max(env_running)        AS max_env_running,
  max(env_limit)          AS max_env_limit,
  max(ck_backlogged)      AS max_ck_backlogged,
  max(ck_max_wait_ms)     AS max_ck_wait_ms,
  sumIf(wait_ms, op = 'started' AND concurrency_key = '')                 AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0 AND concurrency_key = '')        AS wait_ms_count,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(wait_ms, op = 'started' AND wait_ms > 0 AND concurrency_key = '') AS wait_quantiles
FROM trigger_dev.queue_metrics_raw_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;


-- (8) Per-concurrency-key 10s tier. Rows are activity-bound (a (queue, key, bucket) row
-- exists only when that key had an event in that bucket), so user-controlled key
-- cardinality cannot inflate it beyond event volume (~19 bytes/event measured).
-- Lean columns: no nack/dlq deltas and no per-key quantile states (mean wait via sums).
CREATE TABLE IF NOT EXISTS trigger_dev.queue_metrics_ck_v1
(
  organization_id  LowCardinality(String),
  project_id       LowCardinality(String),
  environment_id   String CODEC(ZSTD(1)),
  queue_name       String CODEC(ZSTD(1)),
  concurrency_key  String CODEC(ZSTD(1)),
  bucket_start     DateTime CODEC(Delta(4), ZSTD(1)),

  enqueue_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  started_delta    AggregateFunction(deltaSumTimestamp, UInt64, UInt64),
  ack_delta        AggregateFunction(deltaSumTimestamp, UInt64, UInt64),

  max_queued       SimpleAggregateFunction(max, UInt32),
  max_running      SimpleAggregateFunction(max, UInt32),

  wait_ms_sum      SimpleAggregateFunction(sum, UInt64),
  wait_ms_count    SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, concurrency_key, bucket_start)
TTL bucket_start + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000;

-- (9) MV: raw -> per-key tier. Only rows with a real key: per-key counter rows carry
-- per-key odometers (safe to merge within their own (queue, key) group), and per-key
-- gauge rows carry per-subqueue depth/running.
CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.queue_metrics_ck_mv_v1
TO trigger_dev.queue_metrics_ck_v1 AS
SELECT
  organization_id, project_id, environment_id, queue_name, concurrency_key,
  toStartOfInterval(event_time, INTERVAL 10 SECOND) AS bucket_start,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'enqueue') AS enqueue_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'started') AS started_delta,
  deltaSumTimestampStateIf(cumulative, order_key, op = 'ack')     AS ack_delta,
  maxIf(queued, op = 'gauge')  AS max_queued,
  maxIf(running, op = 'gauge') AS max_running,
  sumIf(wait_ms, op = 'started')          AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0) AS wait_ms_count
FROM trigger_dev.queue_metrics_raw_v1
WHERE concurrency_key != ''
GROUP BY organization_id, project_id, environment_id, queue_name, concurrency_key, bucket_start;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.queue_metrics_ck_mv_v1;
DROP TABLE IF EXISTS trigger_dev.queue_metrics_ck_v1;
DROP VIEW IF EXISTS trigger_dev.queue_metrics_5m_mv_v1;
DROP TABLE IF EXISTS trigger_dev.queue_metrics_5m_v1;
DROP VIEW IF EXISTS trigger_dev.env_metrics_mv_v1;
DROP TABLE IF EXISTS trigger_dev.env_metrics_v1;
DROP VIEW IF EXISTS trigger_dev.queue_metrics_mv_v1;
DROP TABLE IF EXISTS trigger_dev.queue_metrics_v1;
DROP TABLE IF EXISTS trigger_dev.queue_metrics_raw_v1;
