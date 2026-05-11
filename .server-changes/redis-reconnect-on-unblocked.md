---
area: webapp
type: improvement
---

Extend the shared ioredis `reconnectOnError` hook (PR #3548) to also match `UNBLOCKED` reply errors so blocking commands like BLPOP transparently reconnect-and-retry when the ElastiCache primary forces them to unblock during a node role change.
