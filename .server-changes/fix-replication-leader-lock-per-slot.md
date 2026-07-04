---
area: webapp
type: fix
---

Key the logical-replication leader lock on the slot name (not the client name) so consumers of the same replication slot serialize correctly across restarts and rolling deploys
