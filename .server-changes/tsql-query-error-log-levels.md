---
area: webapp
type: fix
---

Invalid queries sent to the query API are no longer treated as internal errors, and a query that does fail is now recorded together with the query text that produced it.
