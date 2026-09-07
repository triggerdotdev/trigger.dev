---
area: webapp
type: fix
---

Deleting a project now stops its pending runs. Runs that were waiting on a `delay` or sitting in the queue are cancelled instead of executing later, and a deleted project no longer sends task failure alerts.
