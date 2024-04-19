---
"@trigger.dev/sdk": patch
"trigger.dev": patch
"@trigger.dev/core": patch
---

When using idempotency keys, triggerAndWait and batchTriggerAndWait will still work even if the existing runs have already been completed (or even partially completed, in the case of batchTriggerAndWait)

- TaskRunExecutionResult.id is now the run friendlyId, not the attempt friendlyId
- A single TaskRun can now have many batchItems, in the case of batchTriggerAndWait while using idempotency keys
- A run’s idempotencyKey is now added to the ctx as well as the TaskEvent and displayed in the span view
- When resolving batchTriggerAndWait, the runtimes no longer reject promises, leading to an error in the parent task

