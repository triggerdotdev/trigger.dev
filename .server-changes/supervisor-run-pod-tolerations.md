---
area: supervisor
type: feature
---

Self-hosted Kubernetes deployments can now add tolerations to run pods, so runs are allowed onto tainted nodes. An invalid toleration now stops the supervisor at startup instead of failing every run pod, so check existing values before upgrading.
