---
area: webapp
type: fix
---

The Sessions list no longer shows an ever-growing duration for a session whose run finished long ago. The duration now stops at the last run's activity, and only sessions with a run still executing keep counting up.
