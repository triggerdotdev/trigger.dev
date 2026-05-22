---
"@trigger.dev/redis-worker": minor
---

`MollifierBuffer`: remove the `entryTtlSeconds` constructor option and stop applying any TTL to buffer entry hashes or idempotency-lookup keys. Buffer entries now persist until the drainer ACKs (with a 30s post-materialise grace TTL) or FAILs them. The previous design auto-evicted entries after the TTL, which silently lost runs when the drainer was offline or falling behind — no PG row, no log, no customer signal. With the TTL gone, the drainer is the only mechanism that removes entries; operators alert on Redis memory pressure (separate, existing concern) and on the `mollifier.stale_entries.current` gauge (5min default threshold) instead. `fail` now also DELs the entry hash plus its idempotency lookup, because the SYSTEM_FAILURE PG row written by the drainer is the canonical record of the failure and the buffer entry is no longer load-bearing.
