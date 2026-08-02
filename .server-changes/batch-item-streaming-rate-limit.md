---
area: webapp
type: fix
---

Batch triggers no longer fail to start their runs when an environment is under heavy API load. If a batch still can't finish being created, `batchTriggerAndWait` now fails with an error instead of leaving the parent run waiting forever, and the batches page says so rather than reporting that it resumed.
