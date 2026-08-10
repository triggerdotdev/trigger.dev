---
area: hosting
type: fix
---

Self-hosted ClickHouse now disables its unbounded internal telemetry tables and keeps query/error logs on a bounded retention, fixing runaway CPU and memory usage on the recommended machine size. Existing self-hosted deployments must drop the previously written disabled log tables separately to reclaim disk.
