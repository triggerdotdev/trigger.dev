---
"@trigger.dev/core": patch
---

Cache the `PUT /realtime/v1/streams/:runId/self/:key` response per `(runId, key)` so repeated `streams.pipe()` / `chat.response.write` / `chat.stream.writer` calls reuse the same S2 credentials instead of issuing a fresh PUT (and the `realtimeStreams || $1` array push it triggers on `TaskRun`) for every chunk. Hot-loop writers, most notably `chat.response.write` called per chunk inside a `chat.agent` turn, now do one PUT per `(run, stream-key)` instead of one per write, eliminating the writer-pool lock contention that scaled with the customer's chunk rate. S2 v2 access tokens are scoped to the org basin with a 1-day server-side TTL so reusing them across calls within a single run is safe; the cache evicts on `createStream` failure and on `manager.reset()`.
