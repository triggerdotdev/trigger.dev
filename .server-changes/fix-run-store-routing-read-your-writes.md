---
area: webapp
type: fix
---

Fix run store routing dropping the caller's read client, which downgraded read-your-writes reads (execution snapshots, waitpoints, batches) to the read replica and could fail dequeues under replica lag
