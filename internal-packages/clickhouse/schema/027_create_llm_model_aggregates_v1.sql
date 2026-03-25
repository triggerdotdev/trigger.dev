-- +goose Up

-- Pre-aggregated model performance metrics with no tenant information.
-- Used for cross-tenant model comparisons in the Model Registry.
-- Aggregated per minute for high-resolution model performance tracking.
CREATE TABLE IF NOT EXISTS trigger_dev.llm_model_aggregates_v1
(
  response_model        String,
  base_response_model   String DEFAULT '',
  gen_ai_system         LowCardinality(String),
  minute                DateTime,

  -- Counts & totals (SimpleAggregateFunction for sum)
  call_count            SimpleAggregateFunction(sum, UInt64),
  total_input_tokens    SimpleAggregateFunction(sum, UInt64),
  total_output_tokens   SimpleAggregateFunction(sum, UInt64),
  total_cost            SimpleAggregateFunction(sum, Float64),

  -- Performance quantiles (AggregateFunction for merge across parts)
  ttfc_quantiles        AggregateFunction(quantiles(0.5, 0.9, 0.95, 0.99), Float64),
  tps_quantiles         AggregateFunction(quantiles(0.5, 0.9, 0.95, 0.99), Float64),
  duration_quantiles    AggregateFunction(quantiles(0.5, 0.9, 0.95, 0.99), UInt64),

  -- Finish reason distribution
  finish_reason_counts  SimpleAggregateFunction(sumMap, Map(String, UInt64))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (response_model, base_response_model, gen_ai_system, minute)
TTL toDate(minute) + INTERVAL 365 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Materialized view that feeds the aggregate table from llm_metrics_v1.
-- Strips all tenant-specific columns (org, project, env, run, span, trace).
-- base_response_model comes from the source table (populated during event enrichment).
CREATE MATERIALIZED VIEW IF NOT EXISTS trigger_dev.llm_model_aggregates_mv_v1
TO trigger_dev.llm_model_aggregates_v1
AS SELECT
  response_model,
  base_response_model,
  gen_ai_system,
  toStartOfMinute(start_time) AS minute,
  count()            AS call_count,
  sum(input_tokens)  AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(total_cost)    AS total_cost,
  quantilesState(0.5, 0.9, 0.95, 0.99)(ms_to_first_chunk) AS ttfc_quantiles,
  quantilesState(0.5, 0.9, 0.95, 0.99)(tokens_per_second)  AS tps_quantiles,
  quantilesState(0.5, 0.9, 0.95, 0.99)(duration)           AS duration_quantiles,
  sumMap(map(finish_reason, toUInt64(1)))                    AS finish_reason_counts
FROM trigger_dev.llm_metrics_v1
WHERE response_model != ''
GROUP BY response_model, base_response_model, gen_ai_system, minute;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.llm_model_aggregates_mv_v1;
DROP TABLE IF EXISTS trigger_dev.llm_model_aggregates_v1;
