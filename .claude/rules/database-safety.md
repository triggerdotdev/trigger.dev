---
paths:
  - "internal-packages/database/**"
---

# Database Migration Safety

- When adding indexes to **existing tables**, use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` to avoid table locks. These must be in their own separate migration file (one index per file).
- Indexes on **newly created tables** (same migration as `CREATE TABLE`) do not need CONCURRENTLY.
- When indexing a **new column on an existing table**, split into two migrations: first `ADD COLUMN IF NOT EXISTS`, then `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in a separate file.
- After generating a migration with Prisma, remove extraneous lines for: `_BackgroundWorkerToBackgroundWorkerFile`, `_BackgroundWorkerToTaskQueue`, `_TaskRunToTaskRunTag`, `_WaitpointRunConnections`, `_completedWaitpoints`, `SecretStore_key_idx`, and unrelated TaskRun indexes.
- Never drop columns or tables without explicit approval.
- New code should target `RunEngineVersion.V2` only.
