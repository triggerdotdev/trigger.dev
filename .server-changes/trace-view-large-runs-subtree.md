---
area: webapp
type: fix
---

Fix empty trace views for child and nested runs in very large traces. The dashboard and retrieve-trace API now return the requested run's span subtree, including ancestor spans outside the anchor run's time window (so a parent's cancellation/error state propagates down correctly).
