---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Sessions — durable, task-bound, bidirectional channel pair that outlives any single run. Foundation for `chat.agent` (separate changeset) and any other "one identifier, many runs over time" workflow.

A `Session` row is keyed on `(env, externalId)` (idempotent upsert), task-bound (`taskIdentifier` + `triggerConfig` are required), and owns its current run via `currentRunId` + `currentRunVersion` (optimistic claim). Three trigger paths: session create, append-time probe (a new run is triggered if the previous one has terminated), and `end-and-continue` for in-task version handoffs.

## SDK

- `SessionHandle` with two asymmetric channels mirroring run-scoped streams:
  - `.in` (`SessionInputChannel`) mirrors `streams.input` — `on` / `once` / `peek` / `wait` / `waitWithIdleTimeout` for the task to consume, `send` for external clients to produce. `.wait` / `.waitWithIdleTimeout` suspend the run on a session-stream waitpoint; the run resumes when a record lands on `.in`.
  - `.out` (`SessionOutputChannel`) mirrors `streams.define` — `append` / `pipe` / `writer` for the task to produce records (all route through direct-to-S2 for uniform parsed-object serialization), plus `read` for external SSE subscribers.
- `sessionStreams` global + `StandardSessionStreamManager` (SSE-backed tail + buffer keyed on `{sessionId, io}`, registered in dev/managed run workers).
- `SessionStreamInstance` for direct-to-S2 piping; `ApiClient.createSessionStreamWaitpoint` wiring.

## Core

- `SessionId` friendly-ID generator and Session schemas, exported from `@trigger.dev/core/v3/isomorphic` alongside `RunId`, `BatchId`, etc.
- `CreateSessionStreamWaitpoint` request/response schemas alongside the main Session CRUD.
- `SessionTriggerConfig` schema: `basePayload`, `machine`, `queue`, `tags`, `maxAttempts`, `idleTimeoutInSeconds`, plus `maxDuration` (per-run wall-clock cap, seconds), `lockToVersion` (pin every run to a specific worker version), and `region` (geographic scheduling). Each forwards to the matching field on `TaskRunOptions` when the run is triggered.
