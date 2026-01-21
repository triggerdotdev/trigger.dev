-- +goose Up
-- Add materialized columns that stringify output and error JSON
-- Returns empty string when the JSON is empty ({}) to simplify search and display
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN output_text String MATERIALIZED if (
  toJSONString (output) = '{}',
  '',
  toJSONString (output)
);

ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN error_text String MATERIALIZED if (
  toJSONString (error) = '{}',
  '',
  toJSONString (error)
);

-- Add ngrambf_v1 indexes for substring searching (e.g., user IDs, error messages)
-- 128KB bloom filter sized for up to 128KB JSON with ~3% false positive rate worst case
ALTER TABLE trigger_dev.task_runs_v2 ADD INDEX idx_output_text output_text TYPE ngrambf_v1 (3, 131072, 3, 0) GRANULARITY 4;

ALTER TABLE trigger_dev.task_runs_v2 ADD INDEX idx_error_text error_text TYPE ngrambf_v1 (3, 131072, 3, 0) GRANULARITY 4;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP INDEX idx_output_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP INDEX idx_error_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN output_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN error_text;