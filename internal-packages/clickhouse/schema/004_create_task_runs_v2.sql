-- +goose Up

/*
  This is the second version of the task runs table.
  The main change is we've added organization_id and project_id to the sort key, and removed the toDate(created_at) and task_identifier columns from the sort key.
  We will add a skip index for the task_identifier column in a future migration.
*/
CREATE TABLE trigger_dev.task_runs_v2
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
  engine                    LowCardinality(String),
  status                    LowCardinality(String),

  /*  ─── queue / concurrency / schedule ─────────────────────── */
  task_identifier           String,
  queue                     String,

  schedule_id               String,
  batch_id                  String,

  /*  ─── related runs ─────────────────────────────────────────────── */
  root_run_id               String,
  parent_run_id             String,
  depth                     UInt8 DEFAULT 0,

  /*  ─── telemetry ─────────────────────────────────────────────── */
  span_id                   String,
  trace_id                  String,
  idempotency_key           String,

  /*  ─── timing ─────────────────────────────────────────────── */
  created_at         DateTime64(3),
  updated_at         DateTime64(3),
  started_at         Nullable(DateTime64(3)),
  executed_at        Nullable(DateTime64(3)),
  completed_at       Nullable(DateTime64(3)),
  delay_until        Nullable(DateTime64(3)),
  queued_at          Nullable(DateTime64(3)),
  expired_at         Nullable(DateTime64(3)),
  expiration_ttl     String,

  /*  ─── cost / usage ───────────────────────────────────────── */
  usage_duration_ms  UInt32  DEFAULT 0,
  cost_in_cents      Float64 DEFAULT 0,
  base_cost_in_cents Float64 DEFAULT 0,

  /*  ─── payload & context ──────────────────────────────────── */
  output             JSON(max_dynamic_paths = 1024),
  error              JSON(max_dynamic_paths = 64),

  /*  ─── tagging / versions ─────────────────────────────────── */
  tags               Array(String) CODEC(ZSTD(1)),
  task_version       String CODEC(LZ4),
  sdk_version        String CODEC(LZ4),
  cli_version        String CODEC(LZ4),
  machine_preset     LowCardinality(String) CODEC(LZ4),

  is_test            UInt8 DEFAULT 0,

  /*  ─── commit lsn ─────────────────────────────────────────────── */
  _version            UInt64,
  _is_deleted         UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(_version, _is_deleted)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_id, environment_id, created_at, run_id)
SETTINGS enable_json_type = 1;

/*  Fast tag filtering  */
ALTER TABLE trigger_dev.task_runs_v2
  ADD INDEX idx_tags tags TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;

CREATE VIEW trigger_dev.tmp_eric_task_runs_full_v2 AS
SELECT
  s.*,
  p.payload as payload
FROM trigger_dev.task_runs_v2 AS s FINAL
LEFT JOIN trigger_dev.raw_task_runs_payload_v1 AS p ON s.run_id = p.run_id
SETTINGS enable_json_type = 1;


-- +goose Down
DROP TABLE IF EXISTS trigger_dev.task_runs_v2;
DROP VIEW IF EXISTS trigger_dev.tmp_eric_task_runs_full_v2