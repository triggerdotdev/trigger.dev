---
paths:
  - "apps/webapp/app/v3/**"
---

# Legacy V1 Engine Code in `app/v3/`

The `v3/` directory name is misleading - most code here is actively used by the current V2 engine. Only the specific files below are legacy V1-only code.

## V1-Only Files - Never Modify

- `marqs/` directory (entire MarQS queue system: sharedQueueConsumer, devQueueConsumer, fairDequeuingStrategy, devPubSub)
- `legacyRunEngineWorker.server.ts` (V1 background job worker)
- `services/triggerTaskV1.server.ts` (deprecated V1 task triggering)
- `services/cancelTaskRunV1.server.ts` (deprecated V1 cancellation)
- `authenticatedSocketConnection.server.ts` (V1 dev WebSocket using DevQueueConsumer)
- `sharedSocketConnection.ts` (V1 shared queue socket using SharedQueueConsumer)

## V1/V2 Branching Pattern

Some services act as routers that branch on `RunEngineVersion`:
- `services/cancelTaskRun.server.ts` - calls V1 service or `engine.cancelRun()` for V2
- `services/batchTriggerV3.server.ts` - uses marqs for V1 path, run-engine for V2

When editing these shared services, only modify V2 code paths.

## V2 Modern Stack

- **Run lifecycle**: `@internal/run-engine` (internal-packages/run-engine)
- **Background jobs**: `@trigger.dev/redis-worker` (not graphile-worker/zodworker)
- **Queue operations**: RunQueue inside run-engine (not MarQS)
- **V2 engine singleton**: `runEngine.server.ts`, `runEngineHandlers.server.ts`
- **V2 workers**: `commonWorker.server.ts`, `alertsWorker.server.ts`, `batchTriggerWorker.server.ts`
