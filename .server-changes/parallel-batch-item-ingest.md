---
area: webapp
type: improvement
---

Phase 2 streaming batch ingest (`POST /api/v3/batches/:batchId/items`) now processes
items with bounded concurrency instead of strictly sequentially. Previously each item's
payload offload + enqueue ran one at a time, so batches of many large payloads (each
offloaded to object storage) could take minutes and blow past Node's default 300s
`server.requestTimeout`, surfacing to the SDK as `408 terminated` and burning ~26 min
across the SDK's 5 retries.

Ingestion now uses `p-map` over the NDJSON stream with a configurable concurrency
(`STREAMING_BATCH_INGEST_CONCURRENCY`, default 10), which pulls lazily so at most
`concurrency` items are in flight — bounding peak memory to roughly
`concurrency × STREAMING_BATCH_ITEM_MAXIMUM_SIZE`. Set it to 1 to fall back to fully
sequential ingestion. Ordering and idempotency are unaffected (run order derives from
each item's index, and `enqueueBatchItem` dedups atomically per index); the NDJSON
parser now stamps oversized-item markers with their emit position so the consumer no
longer depends on processing order. Sealing/idempotency behaviour is unchanged.
