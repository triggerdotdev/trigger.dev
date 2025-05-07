-- +goose Up
SET enable_json_type = 1;

CREATE TABLE trigger_dev.task_runs_v1
(
  /*  ─── ids & hierarchy ─────────────────────────────────────── */
  environment_id            String,
  organization_id           String,
  project_id                String,
  run_id                    String,
  
  environment_type          LowCardinality(String),
  friendly_id               String,
  attempt                   UInt8     DEFAULT 1,

  /*  ─── enums / status ──────────────────────────────────────── */
  engine                    Enum8('V1'=1,'V2'=2) CODEC(T64, LZ4),
  status                    Enum8(
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
                              'TIMED_OUT'=16
                            ),

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
  span_id                   String,
  trace_id                  String,
  idempotency_key           Nullable(String),

  /*  ─── timing ─────────────────────────────────────────────── */
  created_at         DateTime64(3),
  updated_at         DateTime64(3),
  started_at         Nullable(DateTime64(3)),
  executed_at        Nullable(DateTime64(3)),
  completed_at       Nullable(DateTime64(3)),
  delay_until        Nullable(DateTime64(3)),
  queued_at          Nullable(DateTime64(3)),
  expired_at         Nullable(DateTime64(3)),
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

  is_test            UInt8 DEFAULT 0,

  /*  ─── commit lsn ─────────────────────────────────────────────── */
  _version           UInt64
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (toDate(created_at), environment_id, task_identifier, created_at, run_id);

/*  Fast tag filtering  */
ALTER TABLE trigger_dev.task_runs_v1
  ADD INDEX idx_tags tags TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;


-- +goose Down
SET enable_json_type = 0;
DROP TABLE IF EXISTS trigger_dev.task_runs_v1;
