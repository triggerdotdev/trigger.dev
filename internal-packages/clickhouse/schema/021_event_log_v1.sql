-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.event_log_v1
(
    event_id String CODEC(ZSTD(1)),
    event_type String CODEC(ZSTD(1)),
    payload String CODEC(ZSTD(1)),
    payload_type LowCardinality(String) DEFAULT 'application/json',
    published_at DateTime64(3) CODEC(Delta(8), ZSTD(1)),
    environment_id String CODEC(ZSTD(1)),
    project_id String CODEC(ZSTD(1)),
    organization_id String CODEC(ZSTD(1)),
    publisher_run_id String DEFAULT '' CODEC(ZSTD(1)),
    idempotency_key String DEFAULT '' CODEC(ZSTD(1)),
    tags Array(String) DEFAULT [],
    metadata String DEFAULT '{}' CODEC(ZSTD(1)),
    fan_out_count UInt32 DEFAULT 0,
    inserted_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_event_id event_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_publisher_run_id publisher_run_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_idempotency_key idempotency_key TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(published_at)
ORDER BY (project_id, environment_id, event_type, published_at, event_id)
TTL toDateTime(published_at) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.event_log_v1;
