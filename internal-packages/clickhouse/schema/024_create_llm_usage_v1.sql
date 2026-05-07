-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.llm_metrics_v1
(
  -- Tenant context
  organization_id   LowCardinality(String),
  project_id        LowCardinality(String),
  environment_id    String CODEC(ZSTD(1)),
  run_id            String CODEC(ZSTD(1)),
  task_identifier   LowCardinality(String),
  trace_id          String CODEC(ZSTD(1)),
  span_id           String CODEC(ZSTD(1)),

  -- Model & provider
  gen_ai_system     LowCardinality(String),
  request_model     String CODEC(ZSTD(1)),
  response_model    String CODEC(ZSTD(1)),
  matched_model_id  String CODEC(ZSTD(1)),
  operation_id      LowCardinality(String),
  finish_reason     LowCardinality(String),
  cost_source       LowCardinality(String),

  -- Pricing
  pricing_tier_id   String CODEC(ZSTD(1)),
  pricing_tier_name LowCardinality(String),

  -- Token usage
  input_tokens      UInt64 DEFAULT 0,
  output_tokens     UInt64 DEFAULT 0,
  total_tokens      UInt64 DEFAULT 0,
  usage_details     Map(LowCardinality(String), UInt64),

  -- Cost
  input_cost        Decimal64(12) DEFAULT 0,
  output_cost       Decimal64(12) DEFAULT 0,
  total_cost        Decimal64(12) DEFAULT 0,
  cost_details      Map(LowCardinality(String), Decimal64(12)),
  provider_cost     Decimal64(12) DEFAULT 0,

  -- Performance
  ms_to_first_chunk Float64 DEFAULT 0,
  tokens_per_second Float64 DEFAULT 0,

  -- Attribution
  metadata          Map(LowCardinality(String), String),

  -- Timing
  start_time        DateTime64(9) CODEC(Delta(8), ZSTD(1)),
  duration          UInt64 DEFAULT 0 CODEC(ZSTD(1)),
  inserted_at       DateTime64(3) DEFAULT now64(3),

  -- Indexes
  INDEX idx_run_id run_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_span_id span_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_response_model response_model TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_metadata_keys mapKeys(metadata) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(inserted_at)
ORDER BY (organization_id, project_id, environment_id, toDate(inserted_at), run_id)
TTL toDateTime(inserted_at) + INTERVAL 365 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.llm_metrics_v1;
