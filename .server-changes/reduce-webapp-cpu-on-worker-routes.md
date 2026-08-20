---
area: webapp
type: improvement
---

Cut webapp CPU usage by about a quarter on the routes that workers call most, freeing headroom at the same request rate. Detailed event-loop blocking diagnostics are now off by default (set `EVENT_LOOP_MONITOR_ENABLED=1` to restore them); the event-loop utilization metric is unaffected.
