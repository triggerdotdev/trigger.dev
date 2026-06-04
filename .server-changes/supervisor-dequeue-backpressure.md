---
area: supervisor
type: feature
---

Add opt-in dequeue backpressure to the supervisor. When enabled, the supervisor reads a verdict from Redis and pauses dequeuing while the worker cluster is saturated, then resumes once capacity is available. Disabled by default - no behavior change for existing deployments.
