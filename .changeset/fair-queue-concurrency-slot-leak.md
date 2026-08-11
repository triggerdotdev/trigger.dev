---
"@trigger.dev/redis-worker": patch
---

Fair queue consumers no longer leak the concurrency slots that gate a tenant's throughput. Slots were held by messages that had already finished, were never reclaimed, and once enough of them accumulated every queue belonging to that tenant stopped being served. Slots are now freed on the paths that previously skipped them, freed before the record needed to recover them is discarded, and released before a reclaimed message goes back on the queue. A failed release is now surfaced instead of being silently treated as success.

Concurrency groups keyed on queue metadata rather than the tenant can still resolve to the wrong group when a consumer completes a message it did not enqueue, so this does not yet cover that case.
