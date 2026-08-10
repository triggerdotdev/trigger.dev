---
area: hosting
type: fix
---

Self-hosted ClickHouse no longer accumulates unbounded system-log telemetry (metric_log, text_log, asynchronous_metric_log, ...) that eventually pins the CPU in a background merge-retry loop on the recommended machine size; query_log and error_log are kept with a TTL, and the low-memory profile settings now actually apply (moved from config.d to users.d).
