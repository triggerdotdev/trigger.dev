---
area: webapp
type: improvement
---

Optionally route ClickHouse read traffic to a read replica while writes stay on the primary. Set `CLICKHOUSE_READER_URL` to move all reads, or target the busiest paths with `RUNS_LIST_CLICKHOUSE_URL` (runs list) and `EVENTS_READER_CLICKHOUSE_URL` (traces, spans, logs). All optional; unset keeps current behavior.
