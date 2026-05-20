---
area: webapp
type: fix
---

Dedupe the `realtimeStreams` array push on `PUT /realtime/v1/streams/:runId/:target/:streamId` so repeat stream-init calls for the same `(run, streamId)` skip the row UPDATE, mirroring the existing append handler.
