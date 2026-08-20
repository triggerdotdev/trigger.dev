---
area: webapp
type: fix
---

TRQL queries using the PREWHERE clause are now rejected with a clear error message. Use WHERE instead, which is filtered the same way but keeps your data isolation guarantees intact.
