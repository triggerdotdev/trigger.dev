---
area: webapp
type: improvement
---

Add an optional `SENTRY_ENVIRONMENT` env var to set the Sentry environment independently; it falls back to `APP_ENV` when unset, so existing deployments are unchanged.
