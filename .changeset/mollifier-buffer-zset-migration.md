---
"@trigger.dev/redis-worker": patch
---

Migrate the mollifier per-env queue from a Redis LIST to a ZSET scored by `createdAtMicros`. Internal change; the public `MollifierBuffer` API is unchanged. Entry hashes now carry a `createdAtMicros` field matching the ZSET score; `accept` uses `ZADD`, `pop` uses `ZPOPMIN`, `requeue` reuses the original score so retries do not advance the entry's creation timestamp. Listing (`listEntriesForEnv`) reads via `ZREVRANGE`. This unlocks O(log N + pageSize) paginated listing of buffered runs without changing FIFO drain semantics.
