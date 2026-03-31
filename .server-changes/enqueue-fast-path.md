---
area: webapp
type: improvement
---

Reduce run start latency by skipping the intermediate queue when concurrency is available. This optimization is rolled out per-region and enabled automatically for development environments.
