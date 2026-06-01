---
"@trigger.dev/redis-worker": patch
---

`MollifierDrainer` now accepts a `drainBatchSize` option that controls how many entries it pops from a single env per tick. Default remains 1 (one pop per env per tick — previous behaviour). Setting it higher lets a single-env burst drain at handler-parallelism speed instead of one entry per ~50ms tick: the drainer pops up to `drainBatchSize` from the picked env and dispatches all popped entries through the shared `concurrency`-bounded limiter. Org/env fairness is unchanged — the per-tick env selection is unaffected.
