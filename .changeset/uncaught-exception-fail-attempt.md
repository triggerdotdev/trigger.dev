---
"trigger.dev": patch
---

Fail attempts on uncaught exceptions instead of hanging to `MAX_DURATION_EXCEEDED`. A Node `EventEmitter` (e.g. `node-redis`) emitting `"error"` with no `.on("error", ...)` listener escalates to `uncaughtException`, which the worker previously reported but did not act on — runs drifted to maxDuration with empty attempts. They now fail fast with the original error and status `FAILED`. You should still attach `.on("error", ...)` listeners to long-lived clients to handle errors gracefully.
