---
area: webapp
type: feature
---

Automatically migrate the dedicated run-ops database on deploy (entrypoint + `@internal/run-ops-database` deploy/status scripts) and resolve its connection through one canonical `RUN_OPS_DATABASE_URL` (falling back to `TASK_RUN_DATABASE_URL`) so migrations always target the DB the app connects to.
