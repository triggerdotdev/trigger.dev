---
area: webapp
type: improvement
---

Run snapshot polling no longer errors or pays extra latency when the database read replica
briefly lags behind the primary (`RUN_ENGINE_READ_REPLICA_SNAPSHOTS_SINCE_ENABLED`): the read
is served from the primary instead.
