---
area: supervisor
type: improvement
---

Compute workload manager now sets an `org` label on every run (create +
restore) for network-policy selection, instead of a plan-gated label. The
Kubernetes workload manager is unchanged.
