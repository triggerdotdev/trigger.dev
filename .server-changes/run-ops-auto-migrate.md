---
area: webapp
type: feature
---

Automatically migrate the dedicated run-ops database on deploy (entrypoint + `@internal/run-ops-database` deploy/status scripts), and standardize the run-ops DB connection on a single `RUN_OPS_DATABASE_URL` family (dropping the `TASK_RUN_DATABASE_URL` aliases) so migrations always target the DB the app connects to.
