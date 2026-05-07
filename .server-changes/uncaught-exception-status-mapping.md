---
area: run-engine
type: fix
---

Map the new `TASK_RUN_UNCAUGHT_EXCEPTION` internal-error code to
`COMPLETED_WITH_ERRORS` (Failed) status in `runStatusFromError`. cli-v3
now emits this code when the worker process surfaces an uncaught
exception (e.g. a Node EventEmitter emitting `"error"` with no listener),
so the run renders as a regular task failure in the dashboard rather
than a system failure, while still routing through the engine's
`lockedRetryConfig` lookup so the user's retry policy is honoured.
