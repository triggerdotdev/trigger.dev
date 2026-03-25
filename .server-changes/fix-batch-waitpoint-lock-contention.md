---
area: webapp
type: fix
---

Reduce lock contention when processing large `batchTriggerAndWait` batches. Previously, each batch item acquired a Redis lock on the parent run to insert a `TaskRunWaitpoint` row, causing `LockAcquisitionTimeoutError` with high concurrency (880 errors/24h in prod). Since `blockRunWithCreatedBatch` already transitions the parent to `EXECUTING_WITH_WAITPOINTS` before items are processed, the per-item lock is unnecessary. The new `blockRunWithWaitpointLockless` method performs only the idempotent CTE insert without acquiring the lock.
