---
area: webapp
type: fix
---

Parent and root metadata updates from child tasks no longer stall behind a parent run that is being updated by many children at once, and can optionally be buffered in Redis so they survive a webapp restart.
