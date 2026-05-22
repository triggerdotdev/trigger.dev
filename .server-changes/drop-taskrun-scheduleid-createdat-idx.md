---
area: webapp
type: improvement
---

Reduce primary database write load on `TaskRun` by dropping an unused composite index on `(scheduleId, createdAt)`. The schedule list view reads from ClickHouse, so this Postgres index served no Prisma query while still being maintained on every `TaskRun` INSERT/UPDATE.
