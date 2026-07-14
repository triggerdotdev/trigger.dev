---
area: webapp
type: fix
---

Avoid opening a redundant database connection pool when the legacy and primary databases are the same server, preventing connection usage from doubling.
