---
area: webapp
type: fix
---

Dashboard error toasts with very long messages no longer exceed the session cookie limit and break the request; over-long messages are truncated.
