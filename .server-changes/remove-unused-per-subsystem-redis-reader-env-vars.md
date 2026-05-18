---
area: webapp
type: improvement
---

Remove 18 unused `*_REDIS_READER_HOST`/`PORT` env-var declarations from the webapp env schema. They were declared but never consumed by any Redis client. Self-hosters wanting a Redis read split should follow up via a separate issue.
