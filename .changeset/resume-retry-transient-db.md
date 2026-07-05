---
"@trigger.dev/core": patch
---

Runs resuming after a wait now survive a transient platform database outage instead of failing with `TASK_EXECUTION_ABORTED`. The worker retries the resume call generously with jittered backoff, so a brief blip while the run is being continued no longer aborts it.
