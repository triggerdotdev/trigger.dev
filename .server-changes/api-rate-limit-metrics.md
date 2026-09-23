---
area: webapp
type: feature
---

API rate limit usage is now recorded per environment in the `metrics` table as `api.rate_limit.allowed`, `api.rate_limit.denied`, `api.rate_limit.remaining_min` and the limit itself (`api.rate_limit.limit.per_second` and `api.rate_limit.limit.burst`), so you can chart requests against your limit and 429s over time on the Query page and dashboards.
