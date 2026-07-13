---
area: webapp
type: improvement
---

Speed up retrieving a background worker by version. The endpoint no longer runs a slow lookup that scanned the full task table for large deployments; it now reuses data it already loads, so the response is the same but returns much faster.
