---
area: webapp
type: breaking
---

The legacy `clickhouse` event store is retired: task events now go to `clickhouse_v2`. If you self-host with `EVENT_REPOSITORY_DEFAULT_STORE=clickhouse`, switch it to `clickhouse_v2` and follow the self-hosting guide to copy older events, which no longer show until you do.
