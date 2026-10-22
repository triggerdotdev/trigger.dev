---
area: supervisor
type: feature
---

Set `KUBERNETES_POD_RESERVED_SOURCE_PORTS` on the supervisor (for example `50080,50081`) to stop runs using those ports for outbound connections, which is useful to avoid port clashes.
