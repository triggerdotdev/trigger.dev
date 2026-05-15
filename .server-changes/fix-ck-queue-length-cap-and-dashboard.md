---
area: webapp
type: fix
---

Per-queue length limits and the dashboard's "Queued | Running" columns now reflect the true total across all concurrency-key variants. Previously both read 0 for any queue that used concurrency keys, allowing the per-queue cap to be bypassed.
