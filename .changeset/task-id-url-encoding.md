---
"@trigger.dev/core": patch
---

Triggering a task whose id cannot be represented in a URL (for example an id containing an unpaired surrogate) now fails with a clear error naming the task id, instead of a cryptic URI error.
