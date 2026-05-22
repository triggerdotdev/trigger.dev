---
area: webapp
type: fix
---

`engine.createFailedTaskRun` now emits the `runFailed` event so the alert pipeline picks up the SYSTEM_FAILURE row and the event-store handler writes the completion event into the trace. Affects the mollifier drainer's terminal-failure path (introduced in Phase 4G) and the batch-trigger's "queue size limit exceeded" path. Previously these terminal failures landed in PG silently — visible in the dashboard list but never reaching customers' configured TASK_RUN alert channels. The event payload carries `attemptNumber: 0` as the marker that the run never executed (synthesised terminal failure, not exhausted retries).
