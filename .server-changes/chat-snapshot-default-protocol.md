---
area: webapp
type: fix
---

Pin chat.agent session snapshots to a single object store so writes and reads
always round-trip through the same provider when `OBJECT_STORE_DEFAULT_PROTOCOL`
is set.
