---
area: webapp
type: fix
---

Recover from ClickHouse `JSONEachRow` parse failures caused by lone
UTF-16 surrogates in OTel attribute strings (`Cannot parse JSON object
here ... ParallelParsingBlockInputFormat`).

`ClickhouseEventRepository.#flushBatch` and `#flushLlmMetricsBatch` now
retry once after sanitizing every row in the batch: any string value
containing a lone surrogate is replaced with `"[invalid-utf16]"`. If
the sanitizer touched no fields (the parse error isn't a surrogate
issue) or the retry still fails, the batch is dropped without further
ClickHouse round-trips, `permanentlyDroppedBatches` increments, and an
error log with a 1KB sample row is emitted. Non-parse errors propagate
unchanged.

Detection reuses `detectBadJsonStrings` via `JSON.stringify(value)`,
with a latent regex bug fixed: the low-surrogate hex nibble matched
`[cd]` instead of `[c-f]`, missing the U+DE00–U+DFFF half of the range
and false-flagging common emoji pairs. Healthy batches pay zero scan
cost — the check only runs when ClickHouse has already rejected.
