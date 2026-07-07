---
area: webapp
type: fix
---

Runs resuming after a wait no longer fail with TASK_EXECUTION_ABORTED when the database is briefly unreachable; the resume endpoint returns a retryable response for transient infrastructure errors instead of a permanent one.
