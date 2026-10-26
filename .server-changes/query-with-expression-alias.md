---
area: webapp
type: fix
---

Queries using `WITH <expression> AS <name>` now run instead of failing with a syntax error, and the name can be used in the rest of the query. The name can't reuse a table alias used anywhere in the query.
