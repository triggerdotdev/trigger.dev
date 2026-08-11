---
area: webapp
type: improvement
---

Make background worker registration cheaper for projects with many scheduled tasks by scoping declarative schedule reconciliation to the current environment and dropping redundant schedule lookups.
