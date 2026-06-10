---
area: webapp
type: improvement
---

Run snapshot polling no longer errors or pays extra latency when the database read replica
hasn't yet replicated the snapshot the runner is polling from
(`RUN_ENGINE_READ_REPLICA_SNAPSHOTS_SINCE_ENABLED`): the read is served from the primary instead.
