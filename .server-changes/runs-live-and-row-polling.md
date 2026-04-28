---
area: webapp
type: feature
---

Add a "Live" toggle on the Runs index page that auto-revalidates page 1 every 3s, prepending new runs as they arrive. Visible only when no `cursor` param is present. Pauses when the tab is hidden.

Add per-row polling for runs in non-terminal statuses on every page (always on, regardless of the Live toggle). Visible non-terminal rows are refreshed in place via a new resource route `…/runs/refresh?ids=…`, which returns the current row data from Postgres (skipping ClickHouse to avoid replication lag). Polling pauses when the tab is hidden.
