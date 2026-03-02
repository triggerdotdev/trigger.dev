---
paths:
  - "internal-packages/database/**"
---

# Database Migration Safety

- `CREATE INDEX` must use `CONCURRENTLY` to avoid table locks in production.
- `CONCURRENTLY` indexes **must be in their own separate migration file** - they cannot be combined with other schema changes (PostgreSQL requirement).
- After generating a migration with Prisma, remove extraneous lines for: `_BackgroundWorkerToBackgroundWorkerFile`, `_BackgroundWorkerToTaskQueue`, `_TaskRunToTaskRunTag`, `_WaitpointRunConnections`, `_completedWaitpoints`, `SecretStore_key_idx`, and unrelated TaskRun indexes.
- Never drop columns or tables without explicit approval.
- New code should target `RunEngineVersion.V2` only.
