-- +goose Up
-- Per-minute error occurrence counts, keyed by fingerprint + task + version.
-- Powers precise time-range filtering and dynamic-granularity occurrence charts.
CREATE TABLE
  trigger_dev.error_occurrences_v1 (
    organization_id String,
    project_id String,
    environment_id String,
    task_identifier String,
    error_fingerprint String,
    task_version String,
    minute DateTime,
    error_type String,
    error_message String,
    stack_trace String,
    count UInt64,
    INDEX idx_error_type_search lower(error_type) TYPE ngrambf_v1 (3, 32768, 2, 0) GRANULARITY 1,
    INDEX idx_error_message_search lower(error_message) TYPE ngrambf_v1 (3, 32768, 2, 0) GRANULARITY 1
  ) ENGINE = SummingMergeTree (count)
PARTITION BY
  toDate (minute)
ORDER BY
  (
    organization_id,
    project_id,
    environment_id,
    task_identifier,
    error_fingerprint,
    task_version,
    minute
  ) TTL minute + INTERVAL 90 DAY SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW trigger_dev.error_occurrences_mv_v1 TO trigger_dev.error_occurrences_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  toStartOfMinute (created_at) as minute,
  any (
    coalesce(
      nullIf(toString (error.data.type), ''),
      nullIf(toString (error.data.name), ''),
      'Error'
    )
  ) as error_type,
  any (
    coalesce(
      nullIf(
        substring(toString (error.data.message), 1, 500),
        ''
      ),
      'Unknown error'
    )
  ) as error_message,
  any (
    coalesce(
      substring(toString (error.data.stack), 1, 2000),
      ''
    )
  ) as stack_trace,
  count() as count
FROM
  trigger_dev.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN (
    'SYSTEM_FAILURE',
    'CRASHED',
    'INTERRUPTED',
    'COMPLETED_WITH_ERRORS'
  )
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  minute;

-- +goose Down
DROP VIEW IF EXISTS trigger_dev.error_occurrences_mv_v1;

DROP TABLE IF EXISTS trigger_dev.error_occurrences_v1;