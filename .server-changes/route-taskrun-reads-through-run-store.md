---
area: webapp
type: improvement
---

Route Postgres task run reads through the run store so they can be retargeted to a different backing store without changing call sites.
