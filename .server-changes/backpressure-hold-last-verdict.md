---
area: supervisor
type: fix
---

Self-hosted Kubernetes deployments no longer resume pulling work as soon as the safety check becomes unreadable. It now holds its last decision for a grace period while the check recovers.
