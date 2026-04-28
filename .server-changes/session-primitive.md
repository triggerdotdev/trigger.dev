---
area: webapp
type: feature
---

Add the `Session` primitive — a durable, task-bound, bidirectional I/O channel that outlives a single run and acts as the run manager for `chat.agent`. Ships the Postgres `Session` + `SessionRun` tables, ClickHouse `sessions_v1` + replication service, the `sessions` JWT scope, and the public CRUD + realtime routes (`/api/v1/sessions`, `/realtime/v1/sessions/:session/:io`) including `end-and-continue` for server-orchestrated run handoffs and session-stream waitpoints.
