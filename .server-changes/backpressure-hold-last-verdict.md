---
area: supervisor
type: fix
---

When an internal safety check briefly becomes unreadable, the platform now holds its last decision for a short grace period instead of immediately resuming, reducing the risk of piling on more work during a partial outage.
