---
"@trigger.dev/redis-worker": patch
---

Add MollifierBuffer (with `accept`, `pop`, `ack`, `requeue`, `fail`, and `evaluateTrip`) and MollifierDrainer primitives for trigger burst smoothing. `evaluateTrip` is an atomic Lua sliding-window trip evaluator used by the webapp gate to detect per-env trigger bursts. Phase 1 wires MollifierBuffer dual-write monitoring alongside the real trigger path and runs MollifierDrainer's pop/ack loop end-to-end with a no-op handler; full buffering and replayed drainer-side triggers land in later phases.

MollifierDrainer's polling loop now survives transient Redis errors. `processOneFromEnv` catches `buffer.pop()` failures so one env's hiccup doesn't poison the rest of the batch, and the loop wraps each `runOnce` in a try/catch with capped exponential backoff (up to 5s) instead of dying permanently on the first `listEnvs`/`pop` error.

MollifierDrainer rotation is now two-level: orgs at the top, envs within each org. The new `maxOrgsPerTick` option (default 500) caps how many orgs are scheduled per tick; for each picked org, one env is popped (rotating round-robin within the org). The drainer caches `envId → orgId` from popped entries; uncached envs at cold start are treated as their own pseudo-org for one tick, then merge into their real org bucket on subsequent ticks. Effect: an org with N envs gets the same per-tick scheduling slot as an org with 1 env (instead of N slots), so tenant-level drainage throughput no longer scales with that tenant's env count.
