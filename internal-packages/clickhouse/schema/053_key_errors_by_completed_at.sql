-- +goose Up
-- Key error tables by failure time (completed_at) instead of trigger time.
-- Only affects rows inserted after this migration.

ALTER TABLE trigger_dev.errors_mv_v1 MODIFY QUERY
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,

  any(coalesce(nullIf(toString(error.data.name), ''), nullIf(toString(error.data.code), ''), 'Error')) as error_type,
  any(coalesce(
    nullIf(substring(toString(error.data.message), 1, 500), ''),
    nullIf(toString(error.data.name), ''),
    nullIf(substring(toString(error.data.raw), 1, 500), ''),
    'Unknown error'
  )) as error_message,
  any(coalesce(substring(toString(error.data.stackTrace), 1, 2000), '')) as sample_stack_trace,

  toDateTime(max(coalesce(completed_at, created_at))) as last_seen_date,

  min(coalesce(completed_at, created_at)) as first_seen,
  max(coalesce(completed_at, created_at)) as last_seen,
  sumState(toUInt64(1)) as occurrence_count,
  uniqState(task_version) as affected_task_versions,

  anyState(run_id) as sample_run_id,
  anyState(friendly_id) as sample_friendly_id,

  sumMapState([status], [toUInt64(1)]) as status_distribution
FROM trigger_dev.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint;

ALTER TABLE trigger_dev.error_occurrences_mv_v1 MODIFY QUERY
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  toStartOfMinute (coalesce(completed_at, created_at)) as minute,
  any (
    coalesce(
      nullIf(toString (error.data.name), ''),
      nullIf(toString (error.data.code), ''),
      'Error'
    )
  ) as error_type,
  any (
    coalesce(
      nullIf(substring(toString (error.data.message), 1, 500), ''),
      nullIf(toString (error.data.name), ''),
      nullIf(substring(toString (error.data.raw), 1, 500), ''),
      'Unknown error'
    )
  ) as error_message,
  any (
    coalesce(
      substring(toString (error.data.stackTrace), 1, 2000),
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
    'COMPLETED_WITH_ERRORS',
    'TIMED_OUT'
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

ALTER TABLE trigger_dev.errors_mv_v1 MODIFY QUERY
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,

  any(coalesce(nullIf(toString(error.data.name), ''), nullIf(toString(error.data.code), ''), 'Error')) as error_type,
  any(coalesce(
    nullIf(substring(toString(error.data.message), 1, 500), ''),
    nullIf(toString(error.data.name), ''),
    nullIf(substring(toString(error.data.raw), 1, 500), ''),
    'Unknown error'
  )) as error_message,
  any(coalesce(substring(toString(error.data.stackTrace), 1, 2000), '')) as sample_stack_trace,

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
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint;

ALTER TABLE trigger_dev.error_occurrences_mv_v1 MODIFY QUERY
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
      nullIf(toString (error.data.name), ''),
      nullIf(toString (error.data.code), ''),
      'Error'
    )
  ) as error_type,
  any (
    coalesce(
      nullIf(substring(toString (error.data.message), 1, 500), ''),
      nullIf(toString (error.data.name), ''),
      nullIf(substring(toString (error.data.raw), 1, 500), ''),
      'Unknown error'
    )
  ) as error_message,
  any (
    coalesce(
      substring(toString (error.data.stackTrace), 1, 2000),
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
    'COMPLETED_WITH_ERRORS',
    'TIMED_OUT'
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
