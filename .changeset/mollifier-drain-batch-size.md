---
"@trigger.dev/redis-worker": patch
---

`MollifierDrainer` accepts a `drainBatchSize` option (default 1) that lets a single env drain at full `concurrency`-parallelism per tick.
