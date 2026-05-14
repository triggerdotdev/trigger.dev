---
"@trigger.dev/redis-worker": patch
---

Add MollifierBuffer (with `accept`, `pop`, `ack`, `requeue`, `fail`, and `evaluateTrip`) and MollifierDrainer primitives for trigger burst smoothing. `evaluateTrip` is an atomic Lua sliding-window trip evaluator used by the webapp gate to detect per-env trigger bursts. Phase 1 wires MollifierBuffer dual-write monitoring alongside the real trigger path and runs MollifierDrainer's pop/ack loop end-to-end with a no-op handler; full buffering and replayed drainer-side triggers land in later phases.

MollifierDrainer's polling loop now survives transient Redis errors. `processOneFromEnv` catches `buffer.pop()` failures so one env's hiccup doesn't poison the rest of the batch, and the loop wraps each `runOnce` in a try/catch with capped exponential backoff (up to 5s) instead of dying permanently on the first `listEnvs`/`pop` error.

MollifierDrainer accepts a new `maxEnvsPerTick` option (default 500) that bounds per-tick fan-out across the `mollifier:envs` SET. When the set grows beyond the cap (e.g. after an extended drainer outage left entries piled up across many envs), `runOnce` processes a rotating slice rather than queuing one `processOneFromEnv` job per env, and the cursor advances by the slice size so successive ticks sweep through the full set.
