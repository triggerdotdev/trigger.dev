-- +goose Up

CREATE TABLE trigger_dev.sessions_v1
(
  /*  ─── identity ─────────────────────────────────────────────── */
  environment_id      String,
  organization_id     String,
  project_id          String,
  session_id          String,

  environment_type    LowCardinality(String),
  friendly_id         String,
  external_id         String DEFAULT '',

  /*  ─── type discriminator ──────────────────────────────────── */
  type                LowCardinality(String),
  task_identifier     String DEFAULT '',

  /*  ─── filtering / free-form ──────────────────────────────── */
  tags                Array(String) CODEC(ZSTD(1)),
  metadata            JSON(max_dynamic_paths = 256),

  /*  ─── terminal markers ────────────────────────────────────── */
  closed_at           Nullable(DateTime64(3)),
  closed_reason       String DEFAULT '',
  expires_at          Nullable(DateTime64(3)),

  /*  ─── timing ─────────────────────────────────────────────── */
  created_at          DateTime64(3),
  updated_at          DateTime64(3),

  /*  ─── commit lsn ────────────────────────────────────────── */
  _version            UInt64,
  _is_deleted         UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(_version, _is_deleted)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_id, environment_id, created_at, session_id)
SETTINGS enable_json_type = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.sessions_v1;
