---
"@trigger.dev/redis-worker": minor
"@trigger.dev/core": patch
---

Mollifier buffer feature set built on top of the initial primitives: idempotency-lookup with SETNX dedup, atomic snapshot-mutation API (`mutateSnapshot` with tag/metadata/delay/cancel patches), metadata CAS for lossless concurrent updates, watermark-paginated listing, claim primitives for pre-gate idempotency, ZSET-backed per-env queue, 30s post-ack grace TTL, and drop the accept-time entry TTL (drainer is now the only removal mechanism). `@trigger.dev/core` gains an optional `notice` field on the trigger response so the SDK can surface mollifier-queued guidance to customers.
