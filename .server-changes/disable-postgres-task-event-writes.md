---
area: webapp
type: feature
---

Added `EVENT_REPOSITORY_POSTGRES_WRITES_DISABLED` to skip all PostgreSQL task-event writes for deployments that store task events in ClickHouse. Leave it off unless `EVENT_REPOSITORY_DEFAULT_STORE` is `clickhouse_v2`, otherwise task events are lost.
