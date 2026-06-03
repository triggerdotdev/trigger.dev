---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Fix `COULD_NOT_FIND_EXECUTOR` when a task's definition is loaded via `await import(...)` from inside another task's `run()`. The runtime workers now register such tasks with a sentinel file context, and the catalog logs a one-time warning per task id.
