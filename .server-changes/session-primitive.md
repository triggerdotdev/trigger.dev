---
area: webapp
type: feature
---

Add `Session` primitive — a durable, typed, bidirectional I/O primitive that outlives a single run, intended for agent/chat use cases. Ships the Postgres schema (`Session` table), control-plane CRUD routes (`POST/GET/PATCH /api/v1/sessions`, `POST /api/v1/sessions/:session/close` — polymorphic on friendlyId or externalId), `sessions` JWT scope, ClickHouse `sessions_v1` table, and `SessionsReplicationService` (logical replication from Postgres `Session` → ClickHouse `sessions_v1`). Run-scoped realtime streams (`streams.pipe`/`streams.input`) are unchanged and do **not** create Session rows.

Adds `POST /api/v1/runs/:runFriendlyId/session-streams/wait` (session-stream waitpoint creation) and wires `POST /realtime/v1/sessions/:session/:io/append` to fire any pending waitpoints on the channel. Gives `session.in` run-engine waitpoint semantics matching run-scoped input streams: a task can suspend while idle on a session channel and resume when an external client sends a record. Redis-backed pending-waitpoint set (`ssw:{sessionFriendlyId}:{io}`) is drained atomically on each append so multiple concurrent waiters (e.g. multi-tab chat) all resume together.
