---
area: webapp
type: fix
---

Stop API auth failures from leaking the auth controller's raw error string (e.g. internal DB connection errors) to clients; return a fixed status-derived message instead.
