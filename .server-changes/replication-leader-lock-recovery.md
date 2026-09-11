---
area: webapp
type: fix
---

Run replication now recovers on its own after a Redis restart or outage, in place of logging "Cannot extend an already-expired lock" and holding the replication slot open until the server is restarted. Deployments running under a process supervisor can set `RUN_REPLICATION_MAX_RESUBSCRIBE_ATTEMPTS` to exit and be restarted when a stream cannot recover.
