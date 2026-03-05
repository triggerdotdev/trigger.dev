---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"@trigger.dev/database": minor
"apps-webapp": minor
---

Add per-event rate limiting to the pub/sub system. Events can now be configured
with a `rateLimit: { limit, window }` option that limits how many times they can
be published within a sliding time window. When exceeded, the API returns 429
with `x-ratelimit-limit`, `x-ratelimit-remaining`, and `retry-after` headers.
