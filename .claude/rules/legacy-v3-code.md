---
paths:
  - "apps/webapp/app/v3/**"
---

# v3 (engine V1) has been removed

The v3 engine (RunEngineVersion `V1`: MarQS queue + Graphile worker) is end-of-life and its execution code has been removed from the webapp. The `app/v3/` directory name is historical: everything under it now serves the current V2 engine (`@internal/run-engine` + `@trigger.dev/redis-worker`).

There is no `V1` execution path anymore. If you find a `RunEngineVersion` branch, the `V1` arm should only reject or finalize gracefully (for example, mark a historical run cancelled in the DB), never run V1 work. Do not reintroduce MarQS, the graphile worker, or the v3 socket.io namespaces.

## The deprecation boundary (keep this)

Requests from clients still on v3 (old SDK/CLI) or historical V1 runs must return a clean 4xx, never a 5xx. The boundary lives in:

- `engineDeprecation.server.ts` - the `V3_TRIGGER_DEPRECATION_MESSAGE` / `V3_DEV_DEPRECATION_MESSAGE` / `V3_MIGRATION_URL` upgrade messages.
- `engineVersion.server.ts` - `determineEngineVersion()` still detects a V1 project/run so callers can reject it.
- `services/triggerTask.server.ts`, `services/cancelTaskRun.server.ts`, `services/rescheduleTaskRun.server.ts` - the `V1` arm rejects or finalizes gracefully instead of executing.
- `services/initializeDeployment.server.ts` - the `DEPRECATE_V3_CLI_DEPLOYS_ENABLED`-gated v3 CLI deploy rejection.
- `handleWebsockets.server.ts` - the legacy `trigger dev` websocket closes with the upgrade message.

## V2 modern stack

- **Run lifecycle**: `@internal/run-engine` (`runEngine.server.ts`, `runEngineHandlers.server.ts`)
- **Background jobs**: `@trigger.dev/redis-worker` (`commonWorker.server.ts`, `alertsWorker.server.ts`, `batchTriggerWorker.server.ts`; `legacyRunEngineWorker.server.ts` still hosts the live batch-completion jobs)
- **Queue operations**: RunQueue inside run-engine (`runQueue.server.ts`), not MarQS
