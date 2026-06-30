-- +goose Up
-- Store task output as a serialized JSON String alongside the native JSON `output` column.
-- A String has constant binary type complexity regardless of payload depth/width, so writes
-- and reads can never hit input_format_binary_max_type_complexity the way the JSON type can.
ALTER TABLE trigger_dev.task_runs_v2
  ADD COLUMN IF NOT EXISTS output_raw String DEFAULT '';

-- Keep full-text search on output fast now that reads come from output_raw instead of output_text.
ALTER TABLE trigger_dev.task_runs_v2
  ADD INDEX IF NOT EXISTS idx_output_raw output_raw TYPE ngrambf_v1 (3, 131072, 3, 0) GRANULARITY 4;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
  DROP INDEX IF EXISTS idx_output_raw;

ALTER TABLE trigger_dev.task_runs_v2
  DROP COLUMN IF EXISTS output_raw;
