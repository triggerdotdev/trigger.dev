---
area: supervisor
type: feature
---

Self-hosted Kubernetes deployments can now let run pods reach the Kubernetes API. A new option makes mounting the pod's service account token configurable (off by default), so workloads that need in-cluster access — like backup tooling — can be granted it.
