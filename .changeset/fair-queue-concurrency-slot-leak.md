---
"@trigger.dev/redis-worker": patch
---

Fair queue consumers no longer leak concurrency slots. A slot is now always released when a message completes or is put back on the queue, even when its in-flight record has already gone. Leaked slots were never reclaimed, so enough of them would permanently stall every queue belonging to that tenant.
