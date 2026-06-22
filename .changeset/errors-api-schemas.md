---
"@trigger.dev/core": patch
---

Add request and response schemas for the new Errors API (error groups). These back the env-scoped HTTP endpoints for listing error groups, retrieving a single group, and changing its state (resolve, ignore, unresolve), plus a `filter[error]` option on the runs list to fetch the runs behind a group. Exported from `@trigger.dev/core/v3` so the SDK can reuse them.
