---
area: webapp
type: fix
---

`useRealtimeRun` / `subscribeToRun` previously hung silently when the run was still in the mollifier buffer: the realtime route returned 404, Electric's `ShapeStream` stopped on the first response, and the hook never recovered even after the drainer materialised the run. Open the Electric shape stream against a synthetic resource derived from the buffer entry instead — the stream returns an empty initial snapshot and streams the `INSERT` to the client when the drainer creates the PG row. Adds a `mollifier.realtime_subscriptions.buffered` counter and a structured log line on the initial connect for visibility into how often customers subscribe inside the buffered window.
