-- +goose Up
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN error_fingerprint String DEFAULT '';

-- Bloom filter index for fast error fingerprint lookups
ALTER TABLE trigger_dev.task_runs_v2
  ADD INDEX idx_error_fingerprint error_fingerprint TYPE bloom_filter GRANULARITY 4;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2 DROP INDEX idx_error_fingerprint;
ALTER TABLE trigger_dev.task_runs_v2 DROP COLUMN error_fingerprint;
