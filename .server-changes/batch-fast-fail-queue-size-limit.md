---
area: webapp
type: fix
---

Batch items that hit the environment queue size limit now fast-fail without
retries and without creating pre-failed TaskRuns.
