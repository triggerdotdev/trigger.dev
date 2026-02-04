-- +goose Up
-- Update the materialized columns to extract the 'data' field if it exists
-- This avoids the {"data": ...} wrapper in the text representation
-- Note: Direct JSON path access (output.data) returns null for nested objects,
-- so we use JSONExtractRaw on the stringified JSON instead
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN output_text String MATERIALIZED if (
  toJSONString (output) = '{}',
  '',
  if (
    length (JSONExtractRaw (toJSONString (output), 'data')) > 0,
    JSONExtractRaw (toJSONString (output), 'data'),
    toJSONString (output)
  )
);

-- For error: extract error.data if it exists
ALTER TABLE trigger_dev.task_runs_v2
ADD COLUMN error_text String MATERIALIZED if (
  toJSONString (error) = '{}',
  '',
  if (
    length (JSONExtractRaw (toJSONString (error), 'data')) > 0,
    JSONExtractRaw (toJSONString (error), 'data'),
    toJSONString (error)
  )
);

-- Add the indexes
ALTER TABLE trigger_dev.task_runs_v2 ADD INDEX idx_output_text output_text TYPE ngrambf_v1 (3, 131072, 3, 0) GRANULARITY 4;

ALTER TABLE trigger_dev.task_runs_v2 ADD INDEX idx_error_text error_text TYPE ngrambf_v1 (3, 131072, 3, 0) GRANULARITY 4;

-- +goose Down
ALTER TABLE trigger_dev.task_runs_v2
DROP INDEX IF EXISTS idx_output_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP INDEX IF EXISTS idx_error_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN IF EXISTS output_text;

ALTER TABLE trigger_dev.task_runs_v2
DROP COLUMN IF EXISTS error_text;