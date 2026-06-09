---
area: webapp
type: fix
---

Stop `trigger()` from leaking raw database connection errors to API clients during a database outage; infrastructure errors now return a generic, retryable 500.
