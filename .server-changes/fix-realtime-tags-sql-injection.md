---
area: webapp
type: fix
---

Escape single quotes in user-supplied realtime `tags` filter to prevent SQL injection into the Electric `where` clause
