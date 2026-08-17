---
"@trigger.dev/redis-worker": patch
---

Add `MollifierBuffer.evaluateTripGlobal` — a fleet-wide variant of `evaluateTrip` that increments a single shared fixed-window counter regardless of env, so the mollifier can rate-limit the aggregate trigger rate rather than per-env. Reuses the existing trip Lua; keys are hash-tagged for Redis Cluster safety.
