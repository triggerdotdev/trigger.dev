-- +goose Up

-- Aggregated error groups table
CREATE TABLE trigger_dev.errors_v1
(
  organization_id           String,
  project_id                String,
  environment_id            String,
  error_fingerprint         String,

  -- Error details (samples from occurrences)
  error_type                String,
  error_message             String,
  sample_stack_trace        String,

  -- TTL tracking column (regular column for TTL - stores max created_at)
  last_seen_date            DateTime64(3),

  -- Aggregated statistics using AggregateFunction
  first_seen                AggregateFunction(min, DateTime64(3)),
  last_seen                 AggregateFunction(max, DateTime64(3)),
  occurrence_count          AggregateFunction(sum, UInt64),
  affected_tasks            AggregateFunction(uniq, String),
  affected_task_versions    AggregateFunction(uniq, String),

  -- Samples for debugging
  sample_run_id             AggregateFunction(any, String),
  sample_friendly_id        AggregateFunction(any, String),
  sample_task_identifier    AggregateFunction(any, String),

  -- Status distribution
  status_distribution       AggregateFunction(sumMap, Array(String), Array(UInt64))
)
ENGINE = AggregatingMergeTree()
PARTITION BY organization_id
ORDER BY (organization_id, project_id, environment_id, error_fingerprint)
TTL last_seen_date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Materialized view to auto-populate from task_runs_v2
CREATE MATERIALIZED VIEW trigger_dev.mv_errors_v1
TO trigger_dev.errors_v1
AS
SELECT
  organization_id,
  project_id,
  environment_id,
  error_fingerprint,

  -- Use any() for sample values
  any(coalesce(JSONExtractString(error_text, 'type'), JSONExtractString(error_text, 'name'), 'Error')) as error_type,
  any(coalesce(substring(JSONExtractString(error_text, 'message'), 1, 500), 'Unknown error')) as error_message,
  any(coalesce(substring(JSONExtractString(error_text, 'stack'), 1, 2000), '')) as sample_stack_trace,

  -- Regular column for TTL tracking
  max(created_at) as last_seen_date,

  -- Aggregate functions with State combinator
  minState(created_at) as first_seen,
  maxState(created_at) as last_seen,
  sumState(toUInt64(1)) as occurrence_count,
  uniqState(task_identifier) as affected_tasks,
  uniqState(task_version) as affected_task_versions,

  anyState(run_id) as sample_run_id,
  anyState(friendly_id) as sample_friendly_id,
  anyState(task_identifier) as sample_task_identifier,

  sumMapState([status], [toUInt64(1)]) as status_distribution
FROM trigger_dev.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  error_fingerprint;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.mv_errors_v1;
DROP TABLE IF EXISTS trigger_dev.errors_v1;
