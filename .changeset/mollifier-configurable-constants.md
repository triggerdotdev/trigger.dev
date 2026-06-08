---
"@trigger.dev/redis-worker": patch
---

Make mollifier buffer and drainer internals configurable. `MollifierBuffer` now accepts `ackGraceTtlSeconds`, `maxRetriesPerRequest`, `reconnectStepMs`, and `reconnectMaxMs` options, and `MollifierDrainer` accepts `maxBackoffMs` and `backoffFloorMs`. All default to their previous hardcoded values, so existing behaviour is unchanged.
