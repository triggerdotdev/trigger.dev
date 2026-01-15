# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

This is a pnpm 10.23.0 monorepo using Turborepo. Run commands from root with `pnpm run`.

### Essential Commands

```bash
# Start Docker services (PostgreSQL, Redis, Electric)
pnpm run docker

# Run database migrations
pnpm run db:migrate

# Seed the database (required for reference projects)
pnpm run db:seed

# Build packages (required before running)
pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk

# Run webapp in development mode (http://localhost:3030)
pnpm run dev --filter webapp

# Build and watch for changes (CLI and packages)
pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"
```

### Testing

We use vitest exclusively. **Never mock anything** - use testcontainers instead.

```bash
# Run all tests for a package
pnpm run test --filter webapp

# Run a single test file (preferred - cd into directory first)
cd internal-packages/run-engine
pnpm run test ./src/engine/tests/ttl.test.ts --run

# May need to build dependencies first
pnpm run build --filter @internal/run-engine
```

Test files go next to source files (e.g., `MyService.ts` → `MyService.test.ts`).

#### Testcontainers for Redis/PostgreSQL

```typescript
import { redisTest, postgresTest, containerTest } from "@internal/testcontainers";

// Redis only
redisTest("should use redis", async ({ redisOptions }) => {
  /* ... */
});

// PostgreSQL only
postgresTest("should use postgres", async ({ prisma }) => {
  /* ... */
});

// Both Redis and PostgreSQL
containerTest("should use both", async ({ prisma, redisOptions }) => {
  /* ... */
});
```

### Changesets

When modifying any public package (`packages/*` or `integrations/*`), add a changeset:

```bash
pnpm run changeset:add
```

- Default to **patch** for bug fixes and minor changes
- Confirm with maintainers before selecting **minor** (new features)
- **Never** select major (breaking changes) without explicit approval

## Architecture Overview

### Apps

- **apps/webapp**: Remix 2.1.0 app - main API, dashboard, and Docker image. Uses Express server.
- **apps/supervisor**: Node.js app handling task execution, interfacing with Docker/Kubernetes.

### Public Packages

- **packages/trigger-sdk** (`@trigger.dev/sdk`): Main SDK
- **packages/cli-v3** (`trigger.dev`): CLI package
- **packages/core** (`@trigger.dev/core`): Shared code between SDK and webapp. Import subpaths only (never root).
- **packages/build**: Build extensions and types
- **packages/react-hooks**: React hooks for realtime and triggering
- **packages/redis-worker** (`@trigger.dev/redis-worker`): Custom Redis-based background job system

### Internal Packages

- **internal-packages/database** (`@trigger.dev/database`): Prisma 6.14.0 client and schema
- **internal-packages/clickhouse** (`@internal/clickhouse`): ClickHouse client and schema migrations
- **internal-packages/run-engine** (`@internal/run-engine`): "Run Engine 2.0" - run lifecycle management
- **internal-packages/redis** (`@internal/redis`): Redis client creation utilities
- **internal-packages/testcontainers** (`@internal/testcontainers`): Test helpers for Redis/PostgreSQL containers
- **internal-packages/zodworker** (`@internal/zodworker`): Graphile-worker wrapper (being replaced by redis-worker)

### Reference Projects

The `references/` directory contains test workspaces for developing and testing new SDK and platform features. Use these projects (e.g., `references/hello-world`) to manually test changes to the CLI, SDK, core packages, and webapp before submitting PRs.

## Webapp Development

### Key Locations

- Trigger API: `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts`
- Batch trigger: `apps/webapp/app/routes/api.v1.tasks.batch.ts`
- Prisma setup: `apps/webapp/app/db.server.ts`
- Run engine config: `apps/webapp/app/v3/runEngine.server.ts`
- Services: `apps/webapp/app/v3/services/**/*.server.ts`
- Presenters: `apps/webapp/app/v3/presenters/**/*.server.ts`
- OTEL endpoints: `apps/webapp/app/routes/otel.v1.logs.ts`, `otel.v1.traces.ts`

### Environment Variables

Access via `env` export from `apps/webapp/app/env.server.ts`, never `process.env` directly.

For testable code, **never import env.server.ts** in test files. Pass configuration as options instead. Example pattern:

- `realtimeClient.server.ts` (testable service)
- `realtimeClientGlobal.server.ts` (configuration)

### Legacy vs Run Engine 2.0

The codebase is transitioning from the "legacy run engine" (spread across codebase) to "Run Engine 2.0" (`@internal/run-engine`). Focus on Run Engine 2.0 for new work.

## Docker Image Guidelines

When updating Docker image references in `docker/Dockerfile` or other container files:

- **Always use multiplatform/index digests**, not architecture-specific digests
- Architecture-specific digests (e.g., for `linux/amd64` only) will cause CI failures on different build environments
- On Docker Hub, the multiplatform digest is shown on the main image page, while architecture-specific digests are listed under "OS/ARCH"
- Example: Use `node:20.20-bullseye-slim@sha256:abc123...` where the digest is from the multiplatform index, not from a specific OS/ARCH variant

## Database Migrations (PostgreSQL)

1. Edit `internal-packages/database/prisma/schema.prisma`
2. Create migration:
   ```bash
   cd internal-packages/database
   pnpm run db:migrate:dev:create --name "add_new_column"
   ```
3. **Important**: Generated migration includes extraneous changes. Remove lines related to:
   - `_BackgroundWorkerToBackgroundWorkerFile`
   - `_BackgroundWorkerToTaskQueue`
   - `_TaskRunToTaskRunTag`
   - `_WaitpointRunConnections`
   - `_completedWaitpoints`
   - `SecretStore_key_idx`
   - Various `TaskRun` indexes unless you added them
4. Apply migration:
   ```bash
   pnpm run db:migrate:deploy && pnpm run generate
   ```

### Index Migration Rules

- Indexes **must use CONCURRENTLY** to avoid table locks
- **CONCURRENTLY indexes must be in their own separate migration file** - they cannot be combined with other schema changes

## ClickHouse Migrations

ClickHouse migrations use Goose format and live in `internal-packages/clickhouse/schema/`.

1. Create a new numbered SQL file (e.g., `010_add_new_column.sql`)
2. Use Goose markers:

   ```sql
   -- +goose Up
   ALTER TABLE trigger_dev.your_table
   ADD COLUMN new_column String DEFAULT '';

   -- +goose Down
   ALTER TABLE trigger_dev.your_table
   DROP COLUMN new_column;
   ```

Follow naming conventions in `internal-packages/clickhouse/README.md`:

- `raw_` prefix for input tables
- `_v1`, `_v2` suffixes for versioning
- `_mv_v1` suffix for materialized views

## Writing Trigger.dev Tasks

Always import from `@trigger.dev/sdk`. Never use `@trigger.dev/sdk/v3` or deprecated `client.defineJob` pattern.

```typescript
import { task } from "@trigger.dev/sdk";

// Every task must be exported
export const myTask = task({
  id: "my-task", // Unique ID
  run: async (payload: { message: string }) => {
    // Task logic - no timeouts
  },
});
```

### SDK Documentation Rules

The `rules/` directory contains versioned documentation for writing Trigger.dev tasks, distributed to users via the SDK installer. Current version is defined in `rules/manifest.json`.

- `rules/4.3.0/` - Latest: batch trigger v2 (1,000 items, 3MB payloads), debouncing
- `rules/4.1.0/` - Realtime streams v2, updated config
- `rules/4.0.0/` - Base v4 SDK documentation

When adding new SDK features, create a new version directory with only the files that changed from the previous version. Update `manifest.json` to point unchanged files to previous versions.

### Claude Code Skill

The `.claude/skills/trigger-dev-tasks/` skill provides Claude Code with Trigger.dev task expertise. It includes:

- `SKILL.md` - Core instructions and patterns
- Reference files for basic tasks, advanced tasks, scheduled tasks, realtime, and config

Keep the skill in sync with the latest rules version when SDK features change.

## Testing with hello-world Reference Project

First-time setup:

1. Run `pnpm run db:seed` to seed the database (creates the hello-world project)
2. Build CLI: `pnpm run build --filter trigger.dev && pnpm i`
3. Authorize CLI: `cd references/hello-world && pnpm exec trigger login -a http://localhost:3030`

Running:

```bash
cd references/hello-world
pnpm exec trigger dev  # or with --log-level debug
```

## Local Task Testing Workflow

This workflow enables Claude Code to run the webapp and trigger dev simultaneously, trigger tasks, and inspect results for testing code changes.

### Step 1: Start Webapp in Background

```bash
# Run from repo root with run_in_background: true
pnpm run dev --filter webapp
```

Verify webapp is running:

```bash
curl -s http://localhost:3030/healthcheck  # Should return 200
```

### Step 2: Start Trigger Dev in Background

```bash
# Run from hello-world directory with run_in_background: true
cd references/hello-world && pnpm exec trigger dev
```

The worker will build and register tasks. Check output for "Local worker ready [node]" message.

### Step 3: Trigger and Monitor Tasks via MCP

Use the Trigger.dev MCP tools to interact with tasks:

```
# Get current worker and registered tasks
mcp__trigger__get_current_worker(projectRef: "proj_rrkpdguyagvsoktglnod", environment: "dev")

# Trigger a task
mcp__trigger__trigger_task(
  projectRef: "proj_rrkpdguyagvsoktglnod",
  environment: "dev",
  taskId: "hello-world",
  payload: {"message": "Hello from Claude"}
)

# List runs to see status
mcp__trigger__list_runs(
  projectRef: "proj_rrkpdguyagvsoktglnod",
  environment: "dev",
  taskIdentifier: "hello-world",
  limit: 5
)
```

### Step 4: Monitor Execution

- Check trigger dev output file for real-time execution logs
- Successful runs show: `Task | Run ID | Success (Xms)`
- Dashboard available at: http://localhost:3030/orgs/references-9dfd/projects/hello-world-97DT/env/dev/runs

### Key Project Refs

- hello-world: `proj_rrkpdguyagvsoktglnod`
