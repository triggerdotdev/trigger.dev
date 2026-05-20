---
"@trigger.dev/redis-worker": patch
---

Export `SnapshotPatch` and `MutateSnapshotResult` types from `@trigger.dev/redis-worker` so webapp consumers can type-check their callers of `MollifierBuffer.mutateSnapshot`.
