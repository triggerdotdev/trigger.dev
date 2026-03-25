---
area: webapp
type: fix
---

Concurrency-keyed queues now use a single master queue entry per base queue instead of one entry per key. Prevents high-CK-count tenants from consuming the entire parentQueueLimit window and starving other tenants on the same shard.
