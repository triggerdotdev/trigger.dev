---
area: webapp
type: improvement
---

Add `RUNS_LIST_CLICKHOUSE_URL` so runs list reads (dashboard, API, live reload, child-status counts) can use a dedicated ClickHouse client. Falls back to `CLICKHOUSE_URL` when unset, so it's a no-op unless configured.
