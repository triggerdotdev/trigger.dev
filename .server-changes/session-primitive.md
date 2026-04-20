---
area: webapp
type: feature
---

Add `Session` primitive — a durable, typed, bidirectional I/O primitive that outlives a single run, intended for agent/chat use cases. Ships the Postgres schema (`Session` table), control-plane CRUD routes (`POST/GET/PATCH /api/v1/sessions`, `POST /api/v1/sessions/:session/close` — polymorphic on friendlyId or externalId), `sessions` JWT scope, ClickHouse `sessions_v1` table, and `SessionsReplicationService` (logical replication from Postgres `Session` → ClickHouse `sessions_v1`). Run-scoped realtime streams (`streams.pipe`/`streams.input`) are unchanged and do **not** create Session rows.
