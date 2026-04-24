---
area: webapp
type: fix
---

Fix RSS memory leak in the realtime proxy routes. `/realtime/v1/runs`, `/realtime/v1/runs/:id`, and `/realtime/v1/batches/:id` called `fetch()` into Electric with no abort signal, so when a client disconnected mid long-poll, undici kept the upstream socket open and buffered response chunks that would never be consumed — retained only in RSS, invisible to V8 heap tooling. Thread `getRequestAbortSignal()` through `RealtimeClient.streamRun/streamRuns/streamBatch` to `longPollingFetch` and cancel the upstream body in the error path. Isolated reproducer showed ~44 KB retained per leaked request; signal propagation releases it cleanly.
