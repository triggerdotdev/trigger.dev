---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Extend `SessionHandle` with two asymmetric channels mirroring the run-scoped streams primitives:

- `.in` (`SessionInputChannel`) mirrors `streams.input` — `on` / `once` / `peek` / `wait` / `waitWithIdleTimeout` for the task to consume, `send` for external clients to produce. `.wait` / `.waitWithIdleTimeout` suspend the run on a session-stream waitpoint; the run resumes when a record lands on `.in`.
- `.out` (`SessionOutputChannel`) mirrors `streams.define` — `append` / `pipe` / `writer` for the task to produce records (all route through direct-to-S2 for uniform parsed-object serialization), plus `read` for external SSE subscribers.

Adds the `sessionStreams` global + `StandardSessionStreamManager` (SSE-backed tail + buffer keyed on `{sessionId, io}`, registered in dev/managed run workers), `SessionStreamInstance` for direct-to-S2 piping, and `ApiClient.createSessionStreamWaitpoint` wiring.
