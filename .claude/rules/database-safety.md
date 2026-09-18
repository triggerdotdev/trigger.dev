---
paths:
  - "internal-packages/database/**"
  - "internal-packages/run-ops-database/**"
---

# Database Migration Safety

- When adding indexes to **existing tables**, use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` to avoid table locks. These must be in their own separate migration file (one index per file).
- Indexes on **newly created tables** (same migration as `CREATE TABLE`) do not need CONCURRENTLY, but still need `IF NOT EXISTS`. On such a table, `ALTER TABLE ... DROP CONSTRAINT IF EXISTS "name", ADD CONSTRAINT "name" ...` in one statement is an accepted alternative to a DO block for the Prisma-generated constraints.
- When indexing a **new column on an existing table**, split into two migrations: first `ADD COLUMN IF NOT EXISTS`, then `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in a separate file.
- After generating a migration with Prisma, remove extraneous lines for: `_BackgroundWorkerToBackgroundWorkerFile`, `_BackgroundWorkerToTaskQueue`, `_TaskRunToTaskRunTag`, `_WaitpointRunConnections`, `_completedWaitpoints`, `SecretStore_key_idx`, and unrelated TaskRun indexes.
- Every statement must be idempotent so a migration can be re-run after a partial apply: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, `DROP ... IF EXISTS`, `DROP INDEX CONCURRENTLY IF EXISTS`. `CREATE TYPE`, `ADD CONSTRAINT` and `RENAME` have no `IF NOT EXISTS`, so wrap each one in a `DO $$ ... $$` block under an `IF NOT EXISTS (SELECT 1 FROM pg_type / pg_constraint / pg_attribute ...) THEN ... END IF` guard (or give the block an `EXCEPTION WHEN duplicate_object` handler). Data `INSERT`s need `ON CONFLICT`.
- CI enforces this via `pnpm --filter webapp run guard:migrations`; the enforced cutoff date is the `--cutoff` pinned in that script in `apps/webapp/package.json` (rules in `apps/webapp/scripts/migrationSafetyGuard.core.ts`). A statement that genuinely cannot comply may carry `-- migration-guard: allow <reason>` on the line above it.
- Never drop columns or tables without explicit approval.
- New code should target `RunEngineVersion.V2` only.
