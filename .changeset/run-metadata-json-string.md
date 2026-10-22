---
"@trigger.dev/core": patch
---

`metadata.refresh()` now works against deployments where `GET /api/v1/runs/:runId/metadata` returns the run metadata as a JSON string rather than an object. The response schema parses a string payload before validating, so `refresh()` resolves with the same metadata record on every version.
