---
area: webapp
type: improvement
---

Reduce primary database write load on `TaskRun` by dropping an unused composite index on `(status, runtimeEnvironmentId, createdAt, id)`. After gating the legacy `WAITING_FOR_DEPLOY` drain to V1-engine workers only, no V2 Prisma query uses this index while it was still being maintained on every `TaskRun` INSERT/UPDATE.
