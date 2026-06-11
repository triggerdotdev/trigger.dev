---
area: webapp
type: improvement
---

Shrinks the run trace page loader payload by keeping raw span events server-side and makes large trace trees render more efficiently. Also adds an optional `TRACE_VIEW_EMERGENCY_SPAN_CAP` env var that clamps trace summary span limits on both event store paths.
