---
area: webapp
type: improvement
---

Add `EVENTS_READER_CLICKHOUSE_URL` to send trace/span/log reads to a read replica while event inserts stay on `EVENTS_CLICKHOUSE_URL`. Optional; unset keeps reads and writes on the same instance.
