---
area: webapp
type: improvement
---

Optionally report worker queue length metrics continuously (enabled per-service via the RUN_ENGINE_WORKER_QUEUE_OBSERVER_ENABLED env var) so a queue's depth keeps being emitted even when nothing is dequeuing from it.
