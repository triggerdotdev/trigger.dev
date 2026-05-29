-- +goose Up
ALTER TABLE trigger_dev.llm_metrics_v1
  ADD COLUMN prompt_slug LowCardinality(String) DEFAULT '';

ALTER TABLE trigger_dev.llm_metrics_v1
  ADD COLUMN prompt_version UInt32 DEFAULT 0;

-- +goose Down
ALTER TABLE trigger_dev.llm_metrics_v1
  DROP COLUMN prompt_slug;

ALTER TABLE trigger_dev.llm_metrics_v1
  DROP COLUMN prompt_version;
