---
area: webapp
type: feature
---

Mollifier drainer replay: replay buffered entries into `engine.trigger`, stale-entry sweep, a drainer-health gauge, and run-engine cancelled/failed run APIs. Known limitation: stale-sweep runs per-webapp instance, so stale-entry counter metrics multiply by N webapps in HA until a distributed lease lands as follow-up.
