---
area: webapp
type: improvement
---

Replace the expensive DISTINCT query for task filter dropdowns with a dedicated TaskIdentifier registry table backed by Redis. Environments migrate automatically on their next deploy, with a transparent fallback to the legacy query for unmigrated environments. Also fixes duplicate dropdown entries when a task changes trigger source, and adds active/archived grouping for removed tasks. Moves BackgroundWorkerTask reads in the trigger hot path to the read replica.
