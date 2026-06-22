---
area: webapp
type: fix
---

Recover `batchTriggerAndWait` parents that previously hung forever when a batch's item stream never completed. Batches left unsealed past a timeout are now aborted and the waiting parent resumes with an error instead of waiting indefinitely.
