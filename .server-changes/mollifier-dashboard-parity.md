---
area: webapp
type: feature
---

Dashboard parity for runs that live in the mollifier buffer. Synthesises
the SpanRun shape from the buffer snapshot so the run-detail page's
inspector panel renders identically to a PG-resident run. SSE log
stream, realtime stream resources, logs-download and debug resources
fall back to the buffer instead of 404-ing. Short-URL redirects
(`/runs/{id}`, `/@/runs/{id}`, `/projects/v3/{ref}/runs/{id}`) resolve
buffered runs to the canonical dashboard URL. Bulk-cancel scans the
buffer alongside the ClickHouse selection so runs queued mid-burst are
included in the action. Trigger response now carries the snapshot's
spanId so the dashboard's Run Test redirect opens the details panel
without an extra click.
