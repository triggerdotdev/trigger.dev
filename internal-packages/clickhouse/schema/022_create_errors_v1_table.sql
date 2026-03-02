-- +goose Up

-- Aggregated error groups table (per task + fingerprint)
CREATE TABLE trigger_dev.errors_v1
(
  organization_id           String,
  project_id                String,
  environment_id            String,
  task_identifier           String,
  error_fingerprint         String,

  -- Error details (samples from occurrences)
  error_type                String,
  error_message             String,
  sample_stack_trace        String,

  -- SimpleAggregateFunction stores raw values and applies the function during merge,
  -- avoiding binary state encoding issues with AggregateFunction.
  last_seen_date            SimpleAggregateFunction(max, DateTime),

  first_seen                SimpleAggregateFunction(min, DateTime64(3)),
  last_seen                 SimpleAggregateFunction(max, DateTime64(3)),
  occurrence_count          AggregateFunction(sum, UInt64),
  affected_task_versions    AggregateFunction(uniq, String),

  -- Samples for debugging
  sample_run_id             AggregateFunction(any, String),
  sample_friendly_id        AggregateFunction(any, String),

  -- Status distribution
  status_distribution       AggregateFunction(sumMap, Array(String), Array(UInt64))
)
ENGINE = AggregatingMergeTree()
ORDER BY (organization_id, project_id, environment_id, task_identifier, error_fingerprint)
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
  task_identifier,
  error_fingerprint,

  any(coalesce(nullIf(toString(error.data.type), ''), nullIf(toString(error.data.name), ''), 'Error')) as error_type,
  any(coalesce(nullIf(substring(toString(error.data.message), 1, 500), ''), 'Unknown error')) as error_message,
  any(coalesce(substring(toString(error.data.stack), 1, 2000), '')) as sample_stack_trace,

  toDateTime(max(created_at)) as last_seen_date,

  min(created_at) as first_seen,
  max(created_at) as last_seen,
  sumState(toUInt64(1)) as occurrence_count,
  uniqState(task_version) as affected_task_versions,

  anyState(run_id) as sample_run_id,
  anyState(friendly_id) as sample_friendly_id,

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
  task_identifier,
  error_fingerprint;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.mv_errors_v1;
DROP TABLE IF EXISTS trigger_dev.errors_v1;
