---
area: webapp
type: fix
---

Runs that exhaust their dequeue attempts while the run or its environment can't be read now fail with `TASK_RUN_DEQUEUED_MAX_RETRIES` instead of staying queued forever.
