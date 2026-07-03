---
area: webapp
type: improvement
---

Route dashboard and API run/batch/waitpoint presenter reads through the run store so they can be served from a separate backing store without changing call sites.
