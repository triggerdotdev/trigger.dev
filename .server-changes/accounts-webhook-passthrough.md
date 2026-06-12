---
area: webapp
type: feature
---

Add `POST /webhooks/v1/accounts`: a thin passthrough that verifies inbound
webhooks via the SSO plugin and enqueues them on a dedicated worker. No-op
(404) when no plugin is installed.
