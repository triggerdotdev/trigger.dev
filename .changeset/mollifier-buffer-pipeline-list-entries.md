---
"@trigger.dev/redis-worker": patch
---

Pipeline the per-entry `HGETALL` fetches in `MollifierBuffer.listEntriesForEnv`. The previous serial implementation issued one Redis round-trip per runId returned by `LRANGE`, which dominated stale-sweep wall-time at any meaningful backlog (at the sweep's default maxCount=1000, this is ~1000 RTTs per env per pass). Behaviour is unchanged — entries are still skipped when the entry hash has been torn down by a concurrent drainer ack/fail between the LRANGE and the HGETALL.
