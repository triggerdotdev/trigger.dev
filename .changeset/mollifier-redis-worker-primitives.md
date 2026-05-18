---
"@trigger.dev/redis-worker": patch
---

Add MollifierBuffer and MollifierDrainer primitives for trigger burst smoothing.

MollifierBuffer (`accept`, `pop`, `ack`, `requeue`, `fail`, `evaluateTrip`) is a per-env FIFO over Redis with atomic Lua transitions for status tracking. `evaluateTrip` is a sliding-window trip evaluator the webapp gate uses to detect per-env trigger bursts.

MollifierDrainer pops entries through a polling loop with a user-supplied handler. The loop survives transient Redis errors via capped exponential backoff (up to 5s), and per-env pop failures don't poison the rest of the batch — one env's blip is logged and counted as failed for that tick. Rotation is two-level: orgs at the top, envs within each org. The buffer maintains `mollifier:orgs` and `mollifier:org-envs:${orgId}` atomically with per-env queues, so the drainer walks orgs → envs directly without an in-memory cache. The `maxOrgsPerTick` option (default 500) caps how many orgs are scheduled per tick; for each picked org, one env is popped (rotating round-robin within the org). An org with N envs gets the same per-tick scheduling slot as an org with 1 env, so tenant-level drainage throughput is determined by org count rather than env count.
