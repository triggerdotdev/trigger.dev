---
area: webapp
type: improvement
---

Run snapshot polling no longer errors or pays extra latency when the database read replica hasn't yet replicated the snapshot the runner is polling from (`RUN_ENGINE_READ_REPLICA_SNAPSHOTS_SINCE_ENABLED`): the read is briefly retried on the replica and served from the primary if it still hasn't caught up. Polling also now rejects a since-snapshot id that doesn't belong to the run being polled.
