---
"@trigger.dev/redis-worker": patch
---

Add MollifierBuffer (with `accept`, `pop`, `ack`, `requeue`, `fail`, and `evaluateTrip`) and MollifierDrainer primitives for trigger burst smoothing. `evaluateTrip` is an atomic Lua sliding-window trip evaluator used by the webapp gate to detect per-env trigger bursts. Phase 1 wires MollifierBuffer dual-write monitoring alongside the real trigger path and runs MollifierDrainer's pop/ack loop end-to-end with a no-op handler; full buffering and replayed drainer-side triggers land in later phases.
