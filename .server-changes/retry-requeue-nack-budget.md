---
area: webapp
type: fix
---

Task retries that wait in the queue no longer count against the queue's internal redelivery limit, so runs with many long-delay retries are not wrongly failed with TASK_RUN_DEQUEUED_MAX_RETRIES.
