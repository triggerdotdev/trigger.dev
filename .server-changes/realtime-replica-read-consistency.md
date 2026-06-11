---
area: webapp
type: fix
---

Realtime feed reads now wait out measured read-replica lag and retry stale reads, so subscribers receive each change's current content instead of trailing one change behind when a read replica races the write.
