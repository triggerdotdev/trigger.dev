---
area: webapp
type: improvement
---

Add `RUN_ENGINE_READ_REPLICA_SNAPSHOTS_SINCE_ENABLED` flag (default off) to route the Prisma reads inside `RunEngine.getSnapshotsSince` through the read-only replica client. Offloads the snapshot polling queries (fired by every running task runner) from the primary. When disabled, behavior is unchanged.
