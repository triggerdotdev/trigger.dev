-- +goose Up

CREATE TABLE IF NOT EXISTS trigger_dev.webhook_deliveries_v1
(
  environment_id        String,
  organization_id       String,
  project_id            String,
  delivery_id           String,
  webhook_endpoint_id   String,

  environment_type      LowCardinality(String),
  friendly_id           String,

  external_delivery_id  String DEFAULT '',
  run_id                String DEFAULT '',

  status                LowCardinality(String),

  is_test               UInt8 DEFAULT 0,

  created_at            DateTime64(3),
  updated_at            DateTime64(3),

  _version              UInt64,
  _is_deleted           UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(_version, _is_deleted)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_id, environment_id, created_at, delivery_id)
TTL toDateTime(created_at) + INTERVAL 60 DAY
SETTINGS ttl_only_drop_parts = 1, materialize_ttl_recalculate_only = 1;
