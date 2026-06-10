---
area: webapp
type: fix
---

Snapshot polling now rejects a since-snapshot id that doesn't belong to the run being polled,
instead of using its timestamp to return a too-wide window of the run's snapshots.
