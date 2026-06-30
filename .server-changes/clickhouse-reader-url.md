---
area: webapp
type: improvement
---

Add `CLICKHOUSE_READER_URL` to route ClickHouse reads to a read replica while writes stay on `CLICKHOUSE_URL`. Optional; defaults to `CLICKHOUSE_URL`.
