---
"@trigger.dev/core": patch
"run-engine": patch
---

fix: taskIdentifier shows "unknown" in batch.triggerAndWait and batch.triggerByTaskAndWait results

When using `batch.triggerAndWait()` or `batch.triggerByTaskAndWait()`, the `run.taskIdentifier` in the results was showing as "unknown" instead of the actual task identifier (e.g., "generate-audio" or "generate-scene").

This fix:
- Adds `taskIdentifier` field to the `completedByTaskRun` schema in `runEngine.ts`
- Updates `executionSnapshotSystem.ts` to include `taskIdentifier` when fetching waitpoints by joining with the TaskRun table
- Updates `sharedRuntimeManager.ts` to pass through `taskIdentifier` in the execution result

Fixes #2942
