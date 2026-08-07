---
"@trigger.dev/core": patch
---

Unrelated runs are no longer merged into a single trace in your external observability tool when they happen to execute on the same warm worker process. A run and the runs it triggers still share one trace, so a run tree stays together.
