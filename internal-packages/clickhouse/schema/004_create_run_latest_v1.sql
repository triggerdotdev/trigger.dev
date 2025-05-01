-- +goose Up
/* one immutable row = the latest state we know about a run */
CREATE TABLE trigger_dev.run_latest_v1
(
  -- identifiers / partition keys
  environment_id  String,
  run_id          String,
  last_event_time DateTime64(3),
  
  updated_at      DateTime64(3),
  created_at      DateTime64(3),

  environment_type          LowCardinality(Nullable(String)),
  friendly_id               Nullable(String),
  attempt                   UInt8     DEFAULT 1,

  -- user-visible fields
  engine Nullable(Enum8('V1'=1,'V2'=2))
                  CODEC(T64, LZ4),
  status          Enum8(
                    'DELAYED'=1,'PENDING'=2,'PENDING_VERSION'=3,
                    'WAITING_FOR_DEPLOY'=4,'EXECUTING'=5,'WAITING_TO_RESUME'=6,
                    'RETRYING_AFTER_FAILURE'=7,'PAUSED'=8,
                    'CANCELED'=9,'INTERRUPTED'=10,
                    'COMPLETED_SUCCESSFULLY'=11,'COMPLETED_WITH_ERRORS'=12,
                    'SYSTEM_FAILURE'=13,'CRASHED'=14,'EXPIRED'=15,'TIMED_OUT'=16),
  task_identifier Nullable(String),
  task_version    Nullable(String),
  
  sdk_version        Nullable(String) CODEC(LZ4),
  cli_version        Nullable(String) CODEC(LZ4),
  machine_preset     LowCardinality(Nullable(String)) CODEC(LZ4),

  queue           Nullable(String),
  schedule_id     Nullable(String),
  batch_id        Nullable(String),

  root_run_id     Nullable(String),
  depth           UInt8 DEFAULT 0,
  is_test         UInt8 DEFAULT 0,

  started_at      Nullable(DateTime64(3)),
  completed_at    Nullable(DateTime64(3)),
  delay_until     Nullable(DateTime64(3)),

  usage_duration_ms UInt32 DEFAULT 0,
  cost_in_cents      Float64 DEFAULT 0,
  base_cost_in_cents Float64 DEFAULT 0,

  expiration_ttl            Nullable(String),
  expired_at     Nullable(DateTime64(3)),

  span_id        Nullable(String),
  idempotency_key Nullable(String),

  tags           Array(String) CODEC(ZSTD(1)),

  /*  ─── payload & context ──────────────────────────────────── */
  payload            Nullable(JSON(max_dynamic_paths = 2048)),
  output             Nullable(JSON(max_dynamic_paths = 2048)),
  error              Nullable(JSON(max_dynamic_paths = 64)),

  _version       DateTime64(3)   -- used by ReplacingMergeTree dedupe
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (toDate(created_at), environment_id, run_id);

CREATE MATERIALIZED VIEW trigger_dev.run_latest_mv_v1
TO trigger_dev.run_latest_v1
AS
SELECT
    environment_id,
    run_id,
    argMax(status, event_time)                            AS status,
    argMax(updated_at,      event_time)       AS updated_at,
    
    argMaxIf(tags, event_time, notEmpty(tags) > 0) AS tags,

    max(attempt)       AS attempt,

    anyLast(created_at)        AS created_at,
    anyLast(engine)            AS engine,
    anyLast(sdk_version)       AS sdk_version,
    anyLast(cli_version)       AS cli_version,
    anyLast(machine_preset)       AS machine_preset,

    anyLast(environment_type)       AS environment_type,
    anyLast(friendly_id)                       AS friendly_id,
    anyLast(task_identifier)       AS task_identifier,
    anyLast(task_version)       AS task_version,
    anyLast(queue)       AS queue,
    anyLast(schedule_id)       AS schedule_id,
    anyLast(batch_id)       AS batch_id,
    anyLast(root_run_id)       AS root_run_id,
    anyLast(depth)       AS depth,
    anyLast(is_test)       AS is_test,

    anyLast(started_at)       AS started_at,
    anyLast(completed_at)       AS completed_at,
    anyLast(delay_until)       AS delay_until,

    max(usage_duration_ms)       AS usage_duration_ms,
    max(cost_in_cents)       AS cost_in_cents,
    max(base_cost_in_cents)      AS base_cost_in_cents,
    anyLast(expiration_ttl)       AS expiration_ttl,
    anyLast(expired_at)       AS expired_at,
    anyLast(span_id)       AS span_id,
    anyLast(idempotency_key)       AS idempotency_key,

    anyLast(payload)       AS payload,
    anyLast(output)       AS output,
    argMax(error, event_time)       AS error,

    max(event_time)                            AS last_event_time,
    max(event_time)                            AS _version         -- for RMTree
FROM trigger_dev.raw_run_events_v1
GROUP BY
    organization_id,
    project_id,
    environment_id,
    run_id;

-- +goose Down

DROP TABLE trigger_dev.run_latest_mv_v1;
DROP TABLE trigger_dev.run_latest_v1;
