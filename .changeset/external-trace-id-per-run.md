---
"@trigger.dev/core": patch
---

Unrelated runs are no longer merged into a single trace in your external observability tool when they happen to execute on the same warm worker process.
