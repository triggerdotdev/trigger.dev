---
area: supervisor
type: improvement
---

Add a `workload_create_duration_seconds` Prometheus histogram recording the duration and outcome (success/error) of workload manager create calls, labeled by backend (kubernetes/compute/docker). Previously failed creates were only visible as error logs.
