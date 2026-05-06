---
"trigger.dev": patch
---

Fix runs hanging to `MAX_DURATION_EXCEEDED` after an uncaught exception. When a Node `EventEmitter` (e.g. `node-redis`) emits an `"error"` event with no listener attached, Node escalates it to `process.on("uncaughtException")` in the task worker. The worker reported the error via the `UNCAUGHT_EXCEPTION` IPC event but did not exit, and the supervisor-side handler in `taskRunProcess` only logged the message at debug level — leaving the `run()` promise orphaned until `maxDuration` fired and producing empty attempts (`durationMs=0`, `costInCents=0`).

The supervisor now rejects the in-flight attempt with an `UncaughtExceptionError` and gracefully terminates the worker (preserving the OTEL flush window) on `UNCAUGHT_EXCEPTION`. The attempt fails fast with `TASK_EXECUTION_FAILED`, surfacing the original error name, message, and stack trace, and falls under the normal retry policy. This mirrors the existing indexing-side behavior. Apply the same handling to unhandled promise rejections, which Node already routes through `uncaughtException` by default.

Customers should still attach `client.on("error", ...)` listeners to long-lived clients (Redis, Postgres, etc.) and let awaited command rejections drive failure semantics — but a missed listener will no longer silently consume the entire `maxDuration` budget.
