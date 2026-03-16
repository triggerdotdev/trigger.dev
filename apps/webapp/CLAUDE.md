# Webapp

Remix 2.1.0 app serving as the main API, dashboard, and orchestration engine. Uses an Express server (`server.ts`).

## Key File Locations

- **Trigger API**: `app/routes/api.v1.tasks.$taskId.trigger.ts`
- **Batch trigger**: `app/routes/api.v1.tasks.batch.ts`
- **OTEL endpoints**: `app/routes/otel.v1.logs.ts`, `app/routes/otel.v1.traces.ts`
- **Prisma setup**: `app/db.server.ts`
- **Run engine config**: `app/v3/runEngine.server.ts`
- **Services**: `app/v3/services/**/*.server.ts`
- **Presenters**: `app/v3/presenters/**/*.server.ts`

## Route Convention

Routes use Remix flat-file convention with dot-separated segments:
`api.v1.tasks.$taskId.trigger.ts` -> `/api/v1/tasks/:taskId/trigger`

## Environment Variables

Access via `env` export from `app/env.server.ts`. **Never use `process.env` directly.**

For testable code, **never import env.server.ts** in test files. Pass configuration as options instead:
- `realtimeClient.server.ts` (testable service, takes config as constructor arg)
- `realtimeClientGlobal.server.ts` (creates singleton with env config)

## Run Engine 2.0

The webapp integrates `@internal/run-engine` via `app/v3/runEngine.server.ts`. This is the singleton engine instance. Services in `app/v3/services/` call engine methods for all run lifecycle operations (triggering, completing, cancelling, etc.).

The `engineVersion.server.ts` file determines V1 vs V2 for a given environment. New code should always target V2.

## Background Workers

Background job workers use `@trigger.dev/redis-worker`:
- `app/v3/commonWorker.server.ts`
- `app/v3/alertsWorker.server.ts`
- `app/v3/batchTriggerWorker.server.ts`

Do NOT add new jobs using zodworker/graphile-worker (legacy).

## Real-time

- Socket.io: `app/v3/handleSocketIo.server.ts`, `app/v3/handleWebsockets.server.ts`
- Electric SQL: Powers real-time data sync for the dashboard

## Legacy V1 Code

The `app/v3/` directory name is misleading - most code is actively used by V2. Only these specific files are V1-only legacy:
- `app/v3/marqs/` (old MarQS queue system)
- `app/v3/legacyRunEngineWorker.server.ts`
- `app/v3/services/triggerTaskV1.server.ts`
- `app/v3/services/cancelTaskRunV1.server.ts`
- `app/v3/authenticatedSocketConnection.server.ts`
- `app/v3/sharedSocketConnection.ts`

Some services (e.g., `cancelTaskRun.server.ts`, `batchTriggerV3.server.ts`) branch on `RunEngineVersion` to support both V1 and V2. When editing these, only modify V2 code paths.

## Performance: Trigger Hot Path

The `triggerTask.server.ts` service is the **highest-throughput code path** in the system. Every API trigger call goes through it. Keep it fast:

- **Do NOT add database queries** to `triggerTask.server.ts` or `batchTriggerV3.server.ts`. Task defaults (TTL, etc.) are resolved via `backgroundWorkerTask.findFirst()` in the queue concern (`queues.server.ts`) - one query per request, in mutually exclusive branches depending on locked/non-locked path. Piggyback on the existing query instead of adding new ones.
- **Two-stage resolution pattern**: Task metadata is resolved in two stages by design:
  1. **Trigger time** (`triggerTask.server.ts`): Only TTL is resolved from task defaults. Everything else uses whatever the caller provides.
  2. **Dequeue time** (`dequeueSystem.ts`): Full `BackgroundWorkerTask` is loaded and retry config, machine config, maxDuration, etc. are resolved against task defaults.
- If you need to add a new task-level default, **add it to the existing `select` clause** in the `backgroundWorkerTask.findFirst()` query — do NOT add a second query. If the default doesn't need to be known at trigger time, resolve it at dequeue time instead.
- Batch triggers (`batchTriggerV3.server.ts`) follow the same pattern — keep batch paths equally fast.
