---
area: webapp
type: improvement
---

Streaming batch ingest now processes items with bounded concurrency instead of one at a time, so batches of many large payloads ingest far faster and no longer time out. Concurrency is configurable via `STREAMING_BATCH_INGEST_CONCURRENCY` (default 10); set it to 1 for fully sequential ingestion.
