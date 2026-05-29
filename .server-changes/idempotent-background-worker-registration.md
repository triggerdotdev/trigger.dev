---
area: webapp
type: fix
---

Make `POST /api/v1/deployments/:deploymentId/background-workers` idempotent (for sequential requests only) so client-side retries no longer collide on the `BackgroundWorker` `(project, env, version)` unique index. Helps make deployments more resilient against the class of indexing failures that surfaces in the dashboard as "Indexing timed out", e.g. during transient database issues.
