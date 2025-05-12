-- +goose Up
CREATE TABLE IF NOT EXISTS trigger_dev.smoke_test (
    id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3) DEFAULT now64(3),
    message String,
    number UInt32
) ENGINE = MergeTree()
ORDER BY (timestamp, id);

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.smoke_test;
