---
area: webapp
type: feature
---

Add a `RUN_ENGINE_DEQUEUE_DISABLED_WORKER_QUEUES` setting that refuses worker dequeue requests for the listed worker queues (or base regions), so their runs stay queued instead of being handed to workers that can't run them.
