---
area: webapp
type: fix
---

Infer mixed-type JSON arrays as Array(Dynamic) instead of nested tuples when writing run, event, metric, and session data to avoid ClickHouse type-complexity merge failures
