---
"trigger.dev": patch
"@trigger.dev/sdk": patch
---

Add OTEL metrics pipeline for task workers. Workers collect process CPU/memory, Node.js runtime metrics (event loop utilization, event loop delay, heap usage), and user-defined custom metrics via `otel.metrics.getMeter()`. Metrics are exported to ClickHouse with 10-second aggregation buckets and 1m/5m rollups, and are queryable through the dashboard query engine with typed attribute columns, `prettyFormat()` for human-readable values, and AI query support.
