---
area: webapp
type: fix
---

Fix read-replica races on the session APIs: a fresh session's first append or subscribe no longer fails with a 404, and a just-triggered session run is no longer mistaken for dead, which could double-trigger the run and duplicate chat responses.
