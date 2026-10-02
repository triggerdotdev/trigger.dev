-- +goose Up

-- Webhook endpoints, replicated from Postgres for the dashboard's endpoint list, filters and
-- tenant search. One row per endpoint instance, grouped by the declared endpoint id. No TTL:
-- an endpoint lives until it is deleted.
CREATE TABLE IF NOT EXISTS trigger_dev.webhook_endpoints_v1
(
  organization_id        String,
  project_id             String,
  environment_id         String,
  endpoint_id            String,

  friendly_id            String,
  opaque_id              String,
  declared_id            String,
  endpoint_tenant_id     String DEFAULT '',
  endpoint_external_ref  String DEFAULT '',

  source                 LowCardinality(String),
  status                 LowCardinality(String),
  manually_deactivated   UInt8 DEFAULT 0,
  has_signing_secret     UInt8 DEFAULT 0,

  subscriber_ids         Array(String),
  subscribers            String DEFAULT '[]',

  created_at             DateTime64(3),
  updated_at             DateTime64(3),

  _version               UInt64,
  _is_deleted            UInt8 DEFAULT 0,

  INDEX idx_tenant_search lower(endpoint_tenant_id) TYPE ngrambf_v1(3, 32768, 2, 0) GRANULARITY 1,
  INDEX idx_external_ref_search lower(endpoint_external_ref) TYPE ngrambf_v1(3, 32768, 2, 0) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(_version, _is_deleted)
ORDER BY (organization_id, project_id, environment_id, declared_id, endpoint_tenant_id, endpoint_external_ref, endpoint_id);

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.webhook_endpoints_v1;
