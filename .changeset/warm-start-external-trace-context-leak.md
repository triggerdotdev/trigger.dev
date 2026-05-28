---
"@trigger.dev/core": patch
---

Fix external trace context leaking across runs on warm-started workers with `processKeepAlive` enabled. Every subsequent run's attempt span was being exported with the first run's `traceId` and `parentSpanId`, breaking causal-chain navigation in external APM tools. Runs without an external trace context are unaffected.
