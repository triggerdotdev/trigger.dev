---
area: webapp
type: fix
---

Runs replication no longer logs "Cannot extend an already-expired lock" forever after a Redis restart or outage. The leader now re-acquires its lock or steps down once and re-elects, so replication to ClickHouse resumes on its own instead of waiting for a webapp restart.
