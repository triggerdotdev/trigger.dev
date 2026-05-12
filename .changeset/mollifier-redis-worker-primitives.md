---
"@trigger.dev/redis-worker": patch
---

Add MollifierBuffer (with `accept`, `pop`, `ack`, `requeue`, `fail`, and `evaluateTrip`) and MollifierDrainer primitives for trigger burst smoothing. `evaluateTrip` is an atomic Lua sliding-window trip evaluator used by the webapp gate to detect per-env trigger bursts. Webapp shadow-mode logging is wired; buffer writes and drainer activation are deferred to a follow-up.
