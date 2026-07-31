---
area: supervisor
type: improvement
---

Self-hosted Kubernetes deployments now measure the running-task count exactly when deciding whether to pause pulling new work, instead of reading an approximate figure that could differ between reads. The safeguard now engages and releases at the point it is configured to, rather than slightly early or late.
