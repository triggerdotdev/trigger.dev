# Database Package

Prisma 6.14.0 client and schema for PostgreSQL (`@trigger.dev/database`).

## Schema

Located at `prisma/schema.prisma`. Key models include TaskRun, BackgroundWorker, BackgroundWorkerTask, WorkerDeployment, RuntimeEnvironment, and Project.

### Engine Versions

```prisma
enum RunEngineVersion {
  V1  // Legacy (MarQS + Graphile) - DEPRECATED
  V2  // Current (run-engine + redis-worker)
}
```

New code should always target V2.

## Creating Migrations

1. Edit `prisma/schema.prisma`
2. Generate migration:
   ```bash
   cd internal-packages/database
   pnpm run db:migrate:dev:create --name "descriptive_name"
   ```
3. **Clean up generated migration** - remove extraneous lines for:
   - `_BackgroundWorkerToBackgroundWorkerFile`
   - `_BackgroundWorkerToTaskQueue`
   - `_TaskRunToTaskRunTag`
   - `_WaitpointRunConnections`
   - `_completedWaitpoints`
   - `SecretStore_key_idx`
   - Various `TaskRun` indexes (unless you added them)
4. Apply migration:
   ```bash
   pnpm run db:migrate:deploy && pnpm run generate
   ```

## Index Migration Rules

When adding indexes to **existing tables**:

- Use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` to avoid table locks in production
- CONCURRENTLY indexes **must be in their own separate migration file** - they cannot be combined with other schema changes (PostgreSQL requirement)
- Only add one index per migration file
- Pre-apply the index manually in production before deploying the migration (Prisma will skip creation if the index already exists)

Indexes on **newly created tables** (in the same migration as `CREATE TABLE`) do not need CONCURRENTLY and can be in the same migration file.

See `README.md` in this directory and `ai/references/migrations.md` for the full index workflow.

## Read Replicas

Use `$replica` from `~/db.server` for read-heavy queries in the webapp.
