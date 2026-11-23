---
area: webapp
type: breaking
---

If you self-host with task events stored in ClickHouse, new events are now deleted after about 37 days instead of about a year. Events stored before the upgrade keep their old expiry, and you can set `EVENTS_CLICKHOUSE_RETENTION_DAYS` to keep them longer.
