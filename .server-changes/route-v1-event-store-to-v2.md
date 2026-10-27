---
area: webapp
type: breaking
---

Self-hosted instances on the legacy `clickhouse` event store now use `clickhouse_v2`, so run logs and traces recorded before the upgrade no longer show. Set `EVENT_REPOSITORY_DEFAULT_STORE=clickhouse_v2`, or set `EVENT_REPOSITORY_V1_REROUTE_ENABLED=0` to stay on the legacy store.
