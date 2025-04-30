-- +goose Up
/* one immutable row = the latest state we know about a run */
CREATE TABLE trigger_dev.run_latest_v1
(
  -- identifiers / partition keys
  organization_id String,
  project_id      String,
  environment_id  String,
  run_id          String,
  friendly_id     String,
  last_event_time DateTime64(3),

  -- user-visible fields
  status          Enum8(
                    'DELAYED'=1,'PENDING'=2,'PENDING_VERSION'=3,
                    'WAITING_FOR_DEPLOY'=4,'EXECUTING'=5,'WAITING_TO_RESUME'=6,
                    'RETRYING_AFTER_FAILURE'=7,'PAUSED'=8,
                    'CANCELED'=9,'INTERRUPTED'=10,
                    'COMPLETED_SUCCESSFULLY'=11,'COMPLETED_WITH_ERRORS'=12,
                    'SYSTEM_FAILURE'=13,'CRASHED'=14,'EXPIRED'=15,'TIMED_OUT'=16),
  task_identifier String,
  task_version    Nullable(String),
  queue           String,
  schedule_id     Nullable(String),
  batch_id        Nullable(String),

  root_run_id     Nullable(String),
  depth           UInt8,
  is_test         UInt8,

  created_at      DateTime64(3),
  updated_at      DateTime64(3),
  started_at      Nullable(DateTime64(3)),
  completed_at    Nullable(DateTime64(3)),
  delay_until     Nullable(DateTime64(3)),

  usage_duration_ms UInt32,
  cost_in_cents      Float64,
  base_cost_in_cents Float64,

  ttl            Nullable(String),
  expired_at     Nullable(DateTime64(3)),

  span_id        Nullable(String),
  idempotency_key Nullable(String),

  tags           Array(String) CODEC(ZSTD(1)),

  _version       DateTime64(3)   -- used by ReplacingMergeTree dedupe
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMMDD(last_event_time)
ORDER BY (project_id, environment_id, last_event_time, run_id);

CREATE MATERIALIZED VIEW trigger_dev.mv_run_latest_v1
TO trigger_dev.run_latest_v1
AS
SELECT
    organization_id,
    project_id,
    environment_id,
    run_id,
    anyLast(friendly_id)                       AS friendly_id,
    anyLast(status)                            AS status,
    anyLast(task_identifier)       AS task_identifier,
    argMax(task_version,     event_time)       AS task_version,
    argMax(queue,            event_time)       AS queue,
    argMax(schedule_id,      event_time)       AS schedule_id,
    argMax(batch_id,         event_time)       AS batch_id,
    anyLast(root_run_id)       AS root_run_id,
    anyLast(depth)       AS depth,
    anyLast(is_test)       AS is_test,

    min(created_at)                           AS created_at,
    argMax(updated_at,      event_time)       AS updated_at,
    argMax(started_at,       event_time)       AS started_at,
    argMax(completed_at,     event_time)       AS completed_at,
    argMax(delay_until,      event_time)       AS delay_until,

    argMax(usage_duration_ms,event_time)       AS usage_duration_ms,
    argMax(cost_in_cents,    event_time)       AS cost_in_cents,
    argMax(base_cost_in_cents,event_time)      AS base_cost_in_cents,
    argMax(ttl,              event_time)       AS ttl,
    argMax(expired_at,       event_time)       AS expired_at,
    argMax(span_id,          event_time)       AS span_id,
    argMax(idempotency_key,  event_time)       AS idempotency_key,
    argMaxIf(tags, updated_at, arrayLength(tags) > 0) AS tags

    max(event_time)                            AS last_event_time,
    max(event_time)                            AS _version         -- for RMTree
FROM trigger_dev.raw_run_events_v1
GROUP BY
    organization_id,
    project_id,
    environment_id,
    run_id;

-- +goose Down

DROP MATERIALIZED VIEW trigger_dev.mv_run_latest_v1;
DROP TABLE trigger_dev.run_latest_v1;
