---
area: webapp
type: improvement
---

Add per-worker Node.js heap metrics to the OTel meter — `nodejs.memory.heap.used`, `nodejs.memory.heap.total`, `nodejs.memory.heap.limit`, `nodejs.memory.external`, `nodejs.memory.array_buffers`, `nodejs.memory.rss`. Host-metrics only publishes RSS, which overstates V8 heap by the external + native footprint; these give direct heap visibility per cluster worker so `NODE_MAX_OLD_SPACE_SIZE` can be sized against observed heap peaks rather than RSS.
