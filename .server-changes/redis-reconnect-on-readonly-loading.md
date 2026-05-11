---
area: webapp
type: improvement
---

Add `reconnectOnError` to the shared ioredis client config so READONLY / LOADING reply errors during ElastiCache node-type changes trigger a disconnect-reconnect-retry cycle instead of surfacing to caller code.
