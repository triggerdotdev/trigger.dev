-- +goose Up
-- The identity expression permits ngram coexistence. ClickHouse 26.2 uses it for skip
-- pruning, while 26.4 also supports direct reads from the words index. Keep this expression
-- after dropping the ngram index. Do not add a follow-up migration back to the raw column.
ALTER TABLE trigger_dev.task_events_search_v2
  ADD INDEX IF NOT EXISTS idx_search_words concat(search_text, '')
    TYPE text(tokenizer = 'splitByNonAlpha');

-- +goose Down
ALTER TABLE trigger_dev.task_events_search_v2
  DROP INDEX IF EXISTS idx_search_words;
