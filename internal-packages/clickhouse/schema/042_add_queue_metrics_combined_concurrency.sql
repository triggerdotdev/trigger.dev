-- +goose Up

-- Total-concurrency gauges: combined_running is the in-flight count across ALL
-- concurrency-key variants of a queue (the groupConcurrency set), combined_limit the
-- RAW stored total cap (0 = none, readers clamp against max_env_limit). Emitted on
-- base-queue gauge rows only. Per-key gauge rows carry the queue concurrency
-- limit that applied in queue_limit, surfaced in the ck tier as max_limit
-- (1000000 = no explicit limit).

ALTER TABLE trigger_dev.queue_metrics_raw_v1
  ADD COLUMN IF NOT EXISTS combined_running UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS combined_limit UInt32 DEFAULT 0;

ALTER TABLE trigger_dev.queue_metrics_v1
  ADD COLUMN IF NOT EXISTS max_combined_running SimpleAggregateFunction(max, UInt32),
  ADD COLUMN IF NOT EXISTS max_combined_limit SimpleAggregateFunction(max, UInt32);

ALTER TABLE trigger_dev.queue_metrics_5m_v1
  ADD COLUMN IF NOT EXISTS max_combined_running SimpleAggregateFunction(max, UInt32),
  ADD COLUMN IF NOT EXISTS max_combined_limit SimpleAggregateFunction(max, UInt32);

ALTER TABLE trigger_dev.queue_metrics_ck_v1
  ADD COLUMN IF NOT EXISTS max_limit SimpleAggregateFunction(max, UInt32);

-- Materialized views cannot be altered: recreate them with the new columns. The 5m
-- MV MUST keep reading raw, never cascade off queue_metrics_v1 (out-of-time-order
-- deltaSumTimestamp merges double-count bridging spans).

DROP VIEW IF EXISTS trigger_dev.queue_metrics_mv_v1;
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
  max(combined_running)      AS max_combined_running,
  max(combined_limit)        AS max_combined_limit,
  sumIf(wait_ms, op = 'started' AND concurrency_key = '')                 AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0 AND concurrency_key = '')        AS wait_ms_count,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(wait_ms, op = 'started' AND wait_ms > 0 AND concurrency_key = '') AS wait_quantiles
FROM trigger_dev.queue_metrics_raw_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;

DROP VIEW IF EXISTS trigger_dev.queue_metrics_5m_mv_v1;
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
  max(combined_running)      AS max_combined_running,
  max(combined_limit)        AS max_combined_limit,
  sumIf(wait_ms, op = 'started' AND concurrency_key = '')                 AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0 AND concurrency_key = '')        AS wait_ms_count,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(wait_ms, op = 'started' AND wait_ms > 0 AND concurrency_key = '') AS wait_quantiles
FROM trigger_dev.queue_metrics_raw_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;

DROP VIEW IF EXISTS trigger_dev.queue_metrics_ck_mv_v1;
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
  maxIf(queue_limit, op = 'gauge') AS max_limit,
  sumIf(wait_ms, op = 'started')          AS wait_ms_sum,
  countIf(op = 'started' AND wait_ms > 0) AS wait_ms_count
FROM trigger_dev.queue_metrics_raw_v1
WHERE concurrency_key != ''
GROUP BY organization_id, project_id, environment_id, queue_name, concurrency_key, bucket_start;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.queue_metrics_ck_mv_v1;
DROP VIEW IF EXISTS trigger_dev.queue_metrics_5m_mv_v1;
DROP VIEW IF EXISTS trigger_dev.queue_metrics_mv_v1;
ALTER TABLE trigger_dev.queue_metrics_ck_v1 DROP COLUMN IF EXISTS max_limit;
ALTER TABLE trigger_dev.queue_metrics_5m_v1 DROP COLUMN IF EXISTS max_combined_running, DROP COLUMN IF EXISTS max_combined_limit;
ALTER TABLE trigger_dev.queue_metrics_v1 DROP COLUMN IF EXISTS max_combined_running, DROP COLUMN IF EXISTS max_combined_limit;
ALTER TABLE trigger_dev.queue_metrics_raw_v1 DROP COLUMN IF EXISTS combined_running, DROP COLUMN IF EXISTS combined_limit;

-- Recreate the pre-042 materialized views (the definitions from 036) so ingestion keeps
-- feeding every aggregate table after a rollback.
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
