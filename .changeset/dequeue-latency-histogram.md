---
"@trigger.dev/core": patch
---

Record client-side dequeue API latency in the supervisor consumer pool as a Prometheus histogram (`queue_consumer_pool_dequeue_duration_seconds`, labelled by `outcome`: success/empty/error).
