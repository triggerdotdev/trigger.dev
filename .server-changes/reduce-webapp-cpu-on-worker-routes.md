---
area: webapp
type: improvement
---

Cut webapp CPU usage by about a quarter on the routes that workers call most, freeing headroom at the same request rate. Detailed event-loop blocking traces are no longer recorded by default, because producing them was itself a large part of that cost.
