---
area: webapp
type: fix
---

The Sessions list no longer shows an abandoned session as Active with a duration that climbs forever. A session whose run has finished now shows as Idle with a duration frozen at when it stopped, and only sessions with a run still executing show as Active.
