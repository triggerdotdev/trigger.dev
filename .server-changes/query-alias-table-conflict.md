---
area: webapp
type: fix
---

Queries now reject an alias that reuses a table's alias in the same SELECT, unless the aliased expression contains an aggregate or window function (`count() AS runs FROM runs` still works).
