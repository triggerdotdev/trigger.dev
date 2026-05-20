-- +goose Up
ALTER TABLE trigger_dev.llm_metrics_v1
  ADD COLUMN base_response_model String DEFAULT '' CODEC(ZSTD(1));

-- +goose Down
ALTER TABLE trigger_dev.llm_metrics_v1
  DROP COLUMN base_response_model;
