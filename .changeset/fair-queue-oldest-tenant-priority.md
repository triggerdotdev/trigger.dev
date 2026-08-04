---
"@trigger.dev/redis-worker": patch
---

Fix fair queue tenant selection so that, when a maximum tenant count is set, the tenants that have been waiting the longest are picked first instead of being ranked by their raw timestamp.
