---
area: supervisor
type: feature
---

Optional structured event logging for the supervisor - one canonical event per request and per run lifecycle step, with trace context propagated to downstream services so distributed traces stay continuous. Off by default behind `TRIGGER_WIDE_EVENTS_ENABLED`.
