---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Fix the type of the handle returned by `batch.triggerByTask()`. It promised `runs`, `isCached` and `idempotencyKey`, which were never returned, so code like `results.runs[0]` compiled but threw at runtime. The handle is now typed as what it returns: `batchId`, `runCount` and `publicAccessToken`; use `batch.retrieve(batchId)` to get the run IDs, or `batch.triggerByTaskAndWait()` for typed results.
