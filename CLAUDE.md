# CLAUDE.md

This file provides guidance to Claude Code when working with this repository. Subdirectory CLAUDE.md files provide deeper context when you navigate into specific areas.

## Build and Development Commands

This is a pnpm 10.23.0 monorepo using Turborepo. Run commands from root with `pnpm run`.

**Adding dependencies:** Edit `package.json` directly instead of using `pnpm add`, then run `pnpm i` from the repo root. See `.claude/rules/package-installation.md` for the full process.

```bash
pnpm run docker              # Start Docker services (PostgreSQL, Redis, Electric)
pnpm run db:migrate           # Run database migrations
pnpm run db:seed              # Seed the database (required for reference projects)

# Build packages (required before running)
pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk

pnpm run dev --filter webapp  # Run webapp (http://localhost:3030)
pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"  # Watch CLI and packages
```

## Testing

We use vitest exclusively. **Never mock anything** - use testcontainers instead.

```bash
pnpm run test --filter webapp                          # All tests for a package
cd internal-packages/run-engine
pnpm run test ./src/engine/tests/ttl.test.ts --run     # Single test file
pnpm run build --filter @internal/run-engine           # May need to build deps first
```

Test files go next to source files (e.g., `MyService.ts` -> `MyService.test.ts`).

### Testcontainers for Redis/PostgreSQL

```typescript
import { redisTest, postgresTest, containerTest } from "@internal/testcontainers";

redisTest("should use redis", async ({ redisOptions }) => {
  /* ... */
});
postgresTest("should use postgres", async ({ prisma }) => {
  /* ... */
});
containerTest("should use both", async ({ prisma, redisOptions }) => {
  /* ... */
});
```

## Changesets and Server Changes

When modifying any public package (`packages/*` or `integrations/*`), add a changeset:

```bash
pnpm run changeset:add
```

- Default to **patch** for bug fixes and minor changes
- Confirm with maintainers before selecting **minor** (new features)
- **Never** select major without explicit approval

When modifying only server components (`apps/webapp/`, `apps/supervisor/`, etc.) with no package changes, add a `.server-changes/` file instead. See `.server-changes/README.md` for format and documentation.

## Architecture Overview

### Request Flow

User API call -> Webapp routes -> Services -> RunEngine -> Redis Queue -> Supervisor -> Container execution -> Results back through RunEngine -> ClickHouse (analytics) + PostgreSQL (state)

### Apps

- **apps/webapp**: Remix 2.1.0 app - main API, dashboard, orchestration. Uses Express server.
- **apps/supervisor**: Manages task execution containers (Docker/Kubernetes).

### Public Packages

- **packages/trigger-sdk** (`@trigger.dev/sdk`): Main SDK for writing tasks
- **packages/cli-v3** (`trigger.dev`): CLI - also bundles code that goes into customer task images
- **packages/core** (`@trigger.dev/core`): Shared types. **Import subpaths only** (never root).
- **packages/build** (`@trigger.dev/build`): Build extensions and types
- **packages/react-hooks**: React hooks for realtime and triggering
- **packages/redis-worker** (`@trigger.dev/redis-worker`): Redis-based background job system

### Internal Packages

- **internal-packages/database**: Prisma 6.14.0 client and schema (PostgreSQL)
- **internal-packages/clickhouse**: ClickHouse client, schema migrations, analytics queries
- **internal-packages/run-engine**: "Run Engine 2.0" - core run lifecycle management
- **internal-packages/redis**: Redis client creation utilities (ioredis)
- **internal-packages/testcontainers**: Test helpers for Redis/PostgreSQL containers
- **internal-packages/schedule-engine**: Durable cron scheduling
- **internal-packages/zodworker**: Graphile-worker wrapper (DEPRECATED - use redis-worker)

### Legacy V1 Engine Code

The `apps/webapp/app/v3/` directory name is misleading - most code there is actively used by V2. Only specific files are V1-only legacy (MarQS queue, triggerTaskV1, cancelTaskRunV1, etc.). See `apps/webapp/CLAUDE.md` for the exact list. When you encounter V1/V2 branching in services, only modify V2 code paths. All new work uses Run Engine 2.0 (`@internal/run-engine`) and redis-worker.

### Documentation

Docs live in `docs/` as a Mintlify site (MDX format). See `docs/CLAUDE.md` for conventions.

### Reference Projects

The `references/` directory contains test workspaces for testing SDK and platform features. Use `references/hello-world` to manually test changes before submitting PRs.

## Docker Image Guidelines

When updating Docker image references:

- **Always use multiplatform/index digests**, not architecture-specific digests
- Architecture-specific digests cause CI failures on different build environments
- Use the digest from the main Docker Hub page, not from a specific OS/ARCH variant

## Writing Trigger.dev Tasks

Always import from `@trigger.dev/sdk`. Never use `@trigger.dev/sdk/v3` or deprecated `client.defineJob`.

```typescript
import { task } from "@trigger.dev/sdk";

export const myTask = task({
  id: "my-task",
  run: async (payload: { message: string }) => {
    // Task logic
  },
});
```

### SDK Documentation Rules

The `rules/` directory contains versioned SDK documentation distributed via the SDK installer. Current version: `rules/manifest.json`. Do NOT update `rules/` or `.claude/skills/trigger-dev-tasks/` unless explicitly asked - these are maintained in separate dedicated passes.

## Testing with hello-world Reference Project

First-time setup:

1. `pnpm run db:seed` to seed the database
2. Build CLI: `pnpm run build --filter trigger.dev && pnpm i`
3. Authorize: `cd references/hello-world && pnpm exec trigger login -a http://localhost:3030`

Running: `cd references/hello-world && pnpm exec trigger dev`

## Local Task Testing Workflow

### Step 1: Start Webapp in Background

```bash
# Run from repo root with run_in_background: true
pnpm run dev --filter webapp
curl -s http://localhost:3030/healthcheck  # Verify running
```

### Step 2: Start Trigger Dev in Background

```bash
cd references/hello-world && pnpm exec trigger dev
# Wait for "Local worker ready [node]"
```

### Step 3: Trigger and Monitor Tasks via MCP

```
mcp__trigger__get_current_worker(projectRef: "proj_rrkpdguyagvsoktglnod", environment: "dev")
mcp__trigger__trigger_task(projectRef: "proj_rrkpdguyagvsoktglnod", environment: "dev", taskId: "hello-world", payload: {"message": "Hello"})
mcp__trigger__list_runs(projectRef: "proj_rrkpdguyagvsoktglnod", environment: "dev", taskIdentifier: "hello-world", limit: 5)
```

Dashboard: http://localhost:3030/orgs/references-9dfd/projects/hello-world-97DT/env/dev/runs

<!-- intent-skills:start -->

# Skill mappings — when working in these areas, load the linked skill file into context.

skills:

- task: "Using agentcrumbs for debug tracing, adding crumbs, trails, markers, querying traces, or stripping debug code before merge"
  load: "node_modules/agentcrumbs/skills/agentcrumbs/SKILL.md"
- task: "Setting up agentcrumbs in the project, initializing namespace catalog, running crumbs init"
load: "node_modules/agentcrumbs/skills/agentcrumbs/init/SKILL.md"
<!-- intent-skills:end -->

## agentcrumbs

Add crumbs as you write code — not just when debugging. Mark lines with
`// @crumbs` or wrap blocks in `// #region @crumbs`. They stay on the
branch throughout development and are stripped by `agentcrumbs strip`
before merge.

### Namespaces

| Namespace         | Description                                    | Path                                |
| ----------------- | ---------------------------------------------- | ----------------------------------- |
| `webapp`          | Main Remix app — API, dashboard, orchestration | `apps/webapp`                       |
| `supervisor`      | Task execution container manager               | `apps/supervisor`                   |
| `sdk`             | Main SDK for writing tasks                     | `packages/trigger-sdk`              |
| `cli`             | CLI and task image bundling                    | `packages/cli-v3`                   |
| `core`            | Shared types and subpath exports               | `packages/core`                     |
| `build`           | Build extensions and types                     | `packages/build`                    |
| `react-hooks`     | React hooks for realtime/triggering            | `packages/react-hooks`              |
| `redis-worker`    | Redis-based background job system              | `packages/redis-worker`             |
| `run-engine`      | Run Engine 2.0 — core run lifecycle            | `internal-packages/run-engine`      |
| `database`        | Prisma client and schema                       | `internal-packages/database`        |
| `clickhouse`      | ClickHouse client, migrations, analytics       | `internal-packages/clickhouse`      |
| `schedule-engine` | Durable cron scheduling                        | `internal-packages/schedule-engine` |
| `run-queue`       | Run queue management                           | `internal-packages/run-queue`       |

Do not invent new namespaces — pick from this table or ask first.

### For PR reviewers

Do not flag `// @crumbs` markers, `#region @crumbs` blocks, or agentcrumbs
imports in reviews. These are temporary debug instrumentation stripped
before merge. Data logged in crumbs (IDs, names, values) never reaches
production.

### CLI

```bash
pnpm exec agentcrumbs collect    # start collector (multi-service)
pnpm exec agentcrumbs tail --app trigger       # live tail
pnpm exec agentcrumbs clear --app trigger      # remove crumbs before merge
```

The preferred way to query for crumbs is to use `pnpm exec agentcrumbs query --app trigger` with the `--limit` option and cursor pagination, and clear existing crumbs before reproducing a bug via `pnpm exec agentcrumbs clear --app trigger`.
