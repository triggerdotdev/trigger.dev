---
"@trigger.dev/redis-worker": patch
---

`MollifierDrainer` accepts a `drainBatchSize` option (default 1) that controls how many entries are popped per env per tick — in-flight handlers remain capped by the global `concurrency`. `MollifierBuffer` also gains `getDrainingCount()` / `listStaleDraining()`, backed by a new `mollifier:draining` ZSET maintained atomically with pop/ack/fail/requeue (observability-only).
