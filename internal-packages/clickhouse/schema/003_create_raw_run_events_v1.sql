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
  run_id                    String,
  attempt                   UInt8     DEFAULT 1,

  /*  ─── enums / status ──────────────────────────────────────── */
  engine Enum8('V1'=1,'V2'=2)
                  CODEC(T64, LZ4),
  status Enum8(           -- TaskRunStatus
           'DELAYED'=1,'PENDING'=2,'PENDING_VERSION'=3,
           'WAITING_FOR_DEPLOY'=4,'WAITING_FOR_EVENT'=5,
           'RUNNING'=6,'WAITING'=7,'PAUSED'=8,
           /* final */ 'COMPLETED_SUCCESSFULLY'=20,'FAILED'=21,
           'CANCELED'=22,'INTERRUPTED'=23,'CRASHED'=24,
           'EXPIRED'=25,'TIMED_OUT'=26),

  /*  ─── queue / concurrency / schedule ─────────────────────── */
  task_identifier           String,
  queue                     String,

  schedule_id               Nullable(String),
  batch_id                  Nullable(String),

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

  /*  ─── cost / usage ───────────────────────────────────────── */
  usage_duration_ms  UInt32  DEFAULT 0,
  cost_in_cents      Float64 DEFAULT 0,

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
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (environment_id, event_time, run_id)
SETTINGS
    index_granularity = 8192,
    vertical_merge_algorithm_min_rows_to_activate = 100000;

/*  Fast tag filtering  */
ALTER TABLE trigger_dev.raw_run_events_v1
  ADD INDEX idx_tags tags TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;


-- +goose Down
SET enable_json_type = 0;
DROP TABLE IF EXISTS trigger_dev.raw_run_events_v1;
