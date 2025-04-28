-- +goose Up
SET enable_json_type = 1;

/* ─────────────────────────────────────────────────────────────
   RAW EVENT STREAM   trigger_dev.raw_run_events_v1
   ─────────────────────────────────────────────────────────────
   • One row for every status change / retry / metric emission
   • All TaskRun scalar columns duplicated in each row
     – they compress brilliantly and remove JOINs later
   • Heavy blobs → ZSTD
   • High-cardinality enums / strings → LowCardinality + LZ4
   • Array / JSON fields → ZSTD + late-materialised
   • Bloom-filter index on tags for instant “has(tag)”
   ----------------------------------------------------------------- */

CREATE TABLE trigger_dev.raw_run_events_v1
(
  /*  ─── ids & hierarchy ─────────────────────────────────────── */
  environment_id            String,
  environment_type          LowCardinality(String),
  organization_id           String,
  project_id                String,
  run_id                    String,
  friendly_id               String,
  attempt                   UInt8     DEFAULT 1,

  /*  ─── enums / status ──────────────────────────────────────── */
  engine Enum8('V1'=1,'V2'=2)
                  CODEC(T64, LZ4),
  status Enum8(           -- TaskRunStatus
           'DELAYED'=1,
           'PENDING'=2,
           'PENDING_VERSION'=3,
           'WAITING_FOR_DEPLOY'=4,
           'EXECUTING'=5,
           'WAITING_TO_RESUME'=6,
           'RETRYING_AFTER_FAILURE'=7,
           'PAUSED'=8,
           'CANCELED'=9,
           'INTERRUPTED'=10,
           'COMPLETED_SUCCESSFULLY'=11,
           'COMPLETED_WITH_ERRORS'=12,
           'SYSTEM_FAILURE'=13,
           'CRASHED'=14,
           'EXPIRED'=15,
           'TIMED_OUT'=16),

  /*  ─── queue / concurrency / schedule ─────────────────────── */
  task_identifier           String,
  queue                     String,

  schedule_id               Nullable(String),
  batch_id                  Nullable(String),

  /*  ─── related runs ─────────────────────────────────────────────── */
  root_run_id               Nullable(String),
  parent_run_id             Nullable(String),
  depth                     UInt8 DEFAULT 0,

  /*  ─── telemetry ─────────────────────────────────────────────── */
  span_id                   Nullable(String),
  trace_id                  Nullable(String),
  idempotency_key           Nullable(String),

  /*  ─── timing ─────────────────────────────────────────────── */
  event_time         DateTime64(3),          -- when this row created
  created_at         DateTime64(3),
  updated_at         DateTime64(3),
  started_at         Nullable(DateTime64(3)),
  executed_at        Nullable(DateTime64(3)),
  completed_at       Nullable(DateTime64(3)),
  finished_at        Nullable(DateTime64(3)),   -- end of *this* status
  delay_until        Nullable(DateTime64(3)),
  queued_at          Nullable(DateTime64(3)),
  expired_at         Nullable(DateTime64(3)),
  duration_ms        Nullable(UInt32),
  expiration_ttl     Nullable(String),

  /*  ─── cost / usage ───────────────────────────────────────── */
  usage_duration_ms  UInt32  DEFAULT 0,
  cost_in_cents      Float64 DEFAULT 0,
  base_cost_in_cents Float64 DEFAULT 0,

  /*  ─── payload & context ──────────────────────────────────── */
  payload            Nullable(JSON(max_dynamic_paths = 2048)),
  output             Nullable(JSON(max_dynamic_paths = 2048)),
  error              Nullable(JSON(max_dynamic_paths = 64)),

  /*  ─── tagging / versions ─────────────────────────────────── */
  tags               Array(String) CODEC(ZSTD(1)),
  task_version       Nullable(String) CODEC(LZ4),
  sdk_version        Nullable(String) CODEC(LZ4),
  cli_version        Nullable(String) CODEC(LZ4),
  machine_preset     LowCardinality(Nullable(String)) CODEC(LZ4),

  is_test            Nullable(UInt8) DEFAULT 0,
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (organization_id, project_id, environment_id, event_time, run_id)
SETTINGS
    index_granularity = 8192,
    vertical_merge_algorithm_min_rows_to_activate = 100000;

/*  Fast tag filtering  */
ALTER TABLE trigger_dev.raw_run_events_v1
  ADD INDEX idx_tags tags TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;


-- +goose Down
SET enable_json_type = 0;
DROP TABLE IF EXISTS trigger_dev.raw_run_events_v1;
