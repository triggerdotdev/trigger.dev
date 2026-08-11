---
area: webapp
type: improvement
---

Deployment-related API endpoints now draw from their own generous rate limit budget, configurable via the `DEPLOYMENT_RATE_LIMIT_*` environment variables, so runtime API traffic no longer competes with deployments for the same per-environment budget.
