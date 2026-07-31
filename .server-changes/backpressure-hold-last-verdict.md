---
area: supervisor
type: fix
---

Self-hosted Kubernetes deployments no longer resume pulling work the moment the safety check can't be read. It now holds its last decision for a grace period instead of releasing after a few seconds.
