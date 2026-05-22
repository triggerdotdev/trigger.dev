---
area: webapp
type: improvement
---

PendingVersionSystem now discovers PENDING_VERSION run ids via ClickHouse and re-validates each by primary key in Postgres, reducing read load on the TaskRun status index. Uses a dedicated `RUN_ENGINE_CLICKHOUSE_*` client so it doesn't contend with the main analytics pool.
