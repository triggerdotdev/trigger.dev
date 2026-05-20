---
"@trigger.dev/redis-worker": patch
---

Mollifier drainer ack no longer deletes the entry hash. Instead, `MollifierBuffer.ack` sets `materialised=true` on the entry and resets its TTL to a 30s grace window. Entry hashes persist past materialisation as a read-fallback safety net for the brief PG replica-lag window between drainer-side write and reader-side visibility. `BufferEntrySchema` gains an optional `materialised` boolean.
