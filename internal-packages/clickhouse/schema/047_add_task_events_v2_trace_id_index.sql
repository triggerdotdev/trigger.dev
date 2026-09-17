-- +goose Up
-- Bloom-filter skip index on trace_id (the trailing ORDER BY column) so a
-- single-trace read prunes to the trace's footprint, matching the existing
-- run_id / span_id indexes. Metadata-only: ADD INDEX covers new parts only (no
-- MATERIALIZE), so existing parts stay indexed only once they merge or age out
-- under retention -- coverage ramps in, it is not immediate. See the PR for the
-- rollout-window details.
ALTER TABLE trigger_dev.task_events_v2
  ADD INDEX IF NOT EXISTS idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1;

-- +goose Down
ALTER TABLE trigger_dev.task_events_v2
  DROP INDEX IF EXISTS idx_trace_id;
