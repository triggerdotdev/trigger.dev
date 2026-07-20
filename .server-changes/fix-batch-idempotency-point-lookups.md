---
area: webapp
type: fix
---

Speed up idempotency checks on `batchTrigger` calls that use idempotency keys. Large batches against a task with a big run history no longer degrade to multi-second lookups.
