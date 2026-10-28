---
area: supervisor
type: improvement
---

Runs whose container or pod could not be created, or whose pod failed before the run started, can now be requeued straight away instead of waiting for the pending execution timeout. Both are off by default: set `RELEASE_UNSTARTED_RUNS_ENABLED=true` on a supervisor for creates that fail, and `RELEASE_FAILED_POD_RUNS_ENABLED=true` for pods that fail.
