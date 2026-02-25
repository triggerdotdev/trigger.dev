-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.alert_evaluations_v1
(
    -- Alert definition reference
    alert_definition_id String CODEC(ZSTD(1)),

    -- Tenant isolation
    organization_id     LowCardinality(String),
    project_id          LowCardinality(String) DEFAULT '',
    environment_id      String CODEC(ZSTD(1)) DEFAULT '',

    -- When the evaluation ran
    evaluated_at        DateTime64(3) CODEC(Delta(8), ZSTD(1)),

    -- Resulting state: 'ok' or 'firing'
    state               LowCardinality(String),

    -- Whether the state changed compared to the previous evaluation
    state_changed       UInt8 DEFAULT 0,

    -- The numeric value returned by the query (first numeric column of the first row)
    value               Nullable(Float64) CODEC(ZSTD(1)),

    -- JSON serialization of the conditions that were evaluated
    conditions          String CODEC(ZSTD(1)),

    -- How long the ClickHouse query took in milliseconds
    query_duration_ms   UInt32 DEFAULT 0,

    -- Error message if the evaluation failed (query error, etc.)
    error_message       String CODEC(ZSTD(1)) DEFAULT ''
)
ENGINE = MergeTree()
PARTITION BY toDate(evaluated_at)
ORDER BY (alert_definition_id, organization_id, evaluated_at)
TTL toDate(evaluated_at) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.alert_evaluations_v1;
