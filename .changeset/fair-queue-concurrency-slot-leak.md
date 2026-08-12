---
"@trigger.dev/redis-worker": patch
---

Fair queue consumers no longer leak the concurrency slots that gate a tenant's throughput, and leaked slots now heal themselves. Slots are freed on the completion, retry, dead-letter, and reclaim paths that previously skipped them, and a failed release never blocks the message's own state transition, so a Redis error can no longer turn into a duplicate execution or a lost retry. A periodic reconcile loop removes any slot whose message is no longer in flight, and a message that still holds its own slot from an earlier failed release is re-admitted instead of being blocked by it.
