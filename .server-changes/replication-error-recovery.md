---
area: webapp
type: fix
---

Runs and sessions replication services now auto-recover from stream errors (e.g. after a Postgres failover) instead of silently leaving replication stopped. Behaviour is configurable per service — reconnect (default), exit so a process supervisor can restart the host, or log.
