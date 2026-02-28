# Trigger.dev Repo Conventions & Reference

## Build System

- **pnpm 10.23.0** + **Turborepo** + **TypeScript 5.5.4**
- Build order: `core → sdk/build/redis-worker → cli → run-engine → webapp`
- Public packages use **tshy** (dual ESM/CJS), internal use **tsc**
- Custom condition: `@triggerdotdev/source` for dev-time source resolution
- `turbo.json`: `test` depends on `^build`, `dev` depends on `^build` (no cache)

## Build Commands

```bash
pnpm run build --filter @trigger.dev/core          # Build core
pnpm run build --filter @trigger.dev/sdk            # Build SDK (needs core)
pnpm run build --filter webapp                      # Build webapp (needs everything)
pnpm run typecheck                                  # Typecheck all packages
pnpm run check-exports                              # Validate subpath exports (attw)
pnpm run test --filter <package>                    # Run tests
cd <package-dir> && pnpm run test ./path.test.ts --run  # Single test file
```

## CI Requirements (must pass for PRs)

1. TypeScript typecheck
2. Export validation (attw)
3. Unit tests: webapp (8 shards), packages (1 shard), internal (8 shards)
4. E2E tests for CLI (Ubuntu + Windows, npm + pnpm)
5. SDK compatibility (Node 20.20, 22.12, Bun, Deno, Cloudflare Workers)
6. **ESLint and Prettier NOT enforced in CI**
7. Lefthook blocks direct commits to main

## Service Pattern

```typescript
// Extend WithRunEngine for services that need the engine
export class MyService extends WithRunEngine {
  public async call(params: Params): Promise<Result> {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("key", value);
      // ... business logic
    });
  }
}

// Errors
throw new ServiceValidationError("message", 422);

// Error-safe async
const [error, result] = await tryCatch(asyncOperation());
if (error) { throw new ServiceValidationError("..."); }
```

## API Route Pattern

```typescript
const { action, loader } = createActionApiRoute(
  {
    headers: HeadersSchema,
    params: ParamsSchema,
    body: BodySchema,
    allowJWT: true,
    maxContentLength: env.TASK_PAYLOAD_MAXIMUM_SIZE,
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.taskId }),
      superScopes: ["write:tasks", "admin"],
    },
    corsStrategy: "all",
  },
  async ({ body, headers, params, authentication }) => {
    // authentication.environment = AuthenticatedEnvironment
    const service = new MyService();
    const result = await service.call(/* ... */);
    return json(result, { status: 200 });
  }
);
export { action, loader };
```

## Test Pattern

```typescript
import { containerTest } from "@internal/testcontainers";

vi.setConfig({ testTimeout: 60_000 });

describe("MyFeature", () => {
  containerTest("should work", async ({ prisma, redisOptions }) => {
    const engine = new RunEngine({ prisma, worker: { redis: redisOptions, ... } });
    // ... test with real DB and Redis
  });
});
```

- Tests next to source: `MyService.ts` → `MyService.test.ts`
- **Never mock** — use testcontainers
- Pre-pull Docker images: PostgreSQL 14, ClickHouse, Redis, Electric 1.2.4

## SDK Pattern

```typescript
// Task definition: packages/trigger-sdk/src/v3/tasks.ts
export const task = createTask;

// Trigger flow: shared.ts → trigger_internal() → apiClient.triggerTask()
// HTTP: POST /api/v1/tasks/{taskId}/trigger
// Auth: Bearer {apiKey} in Authorization header
// Payload: stringifyIO() for serialization
```

## Worker Registration

- File: `apps/webapp/app/v3/services/createBackgroundWorker.server.ts`
- Flow: `createBackgroundWorker()` → `createWorkerResources()` → `createWorkerTasks()` + `syncDeclarativeSchedules()`
- Each task gets a `BackgroundWorkerTask` record with slug, queue, retry config
- Queues: VIRTUAL (auto per task) or NAMED (explicit)

## Key Utilities

- `generateFriendlyId("prefix")` → `prefix_xxxxx` (for user-facing IDs)
- `RunId.generate()` → `{ id, friendlyId }` for run IDs
- `stringifyIO()` / `conditionallyExportPacket()` for payload serialization
- `handleRequestIdempotency()` for request-level caching
- `createTags()` for tag creation/linking
- `parseDelay()` for delay string parsing
- `tryCatch()` for error-safe async operations
- `logger.debug/info/warn/error()` for logging

## Import Rules

- `@trigger.dev/core`: ALWAYS import subpaths (`@trigger.dev/core/v3`, etc.), NEVER root
- `env.server.ts`: NEVER import in test files, pass config as options
- Services: `service.server.ts` (testable) + `serviceGlobal.server.ts` (config singleton)

## Database Conventions

- Models: PascalCase, Fields: camelCase
- IDs: `id String @id @default(cuid())`
- Timestamps: `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`
- Migrations: remove extraneous lines (see CLAUDE.md list)
- Indexes: CONCURRENTLY in separate migration files

## Prisma Client

- Global instance: `apps/webapp/app/db.server.ts`
- Replica: `$replica` for read-only queries
- Transactions: `prisma.$transaction(async (tx) => { ... })`

## Core Package Exports (critical)

- ~30 subpath exports in `packages/core/package.json`
- New exports need entries in `tshy.exports` + rebuild
- Validated by `check-exports` in CI

## Changeset Rules

- Required for any `packages/*` or `integrations/*` changes
- Default: **patch** for bug fixes
- **minor** requires maintainer confirmation
- **major** requires explicit approval
- Fixed group: `[@trigger.dev/*, trigger.dev]` released together

## Run Engine Trigger Flow (for reference)

```
SDK trigger() → HTTP POST /api/v1/tasks/{taskId}/trigger
  → createActionApiRoute (auth + validation)
    → TriggerTaskService.call() (engine version routing)
      → RunEngineTriggerTaskService.call() (validation, delay, TTL, idempotency, queue)
        → engine.trigger() (debounce, create TaskRun, emit "runCreated")
          → eventBus.emit("runCreated", { runId })
```

## Docker Services (for development)

- PostgreSQL 14: port 5432 (postgres/postgres)
- Redis 7: port 6379
- Electric 1.2.4: port 3060
- ClickHouse 25.6.2: ports 8123/9000 (default/password)
- Start: `pnpm run docker`
