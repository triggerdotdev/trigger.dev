---
area: webapp
type: improvement
---

Cache task defaults in Redis so the trigger API skips per-request database lookups, restoring the fast trigger path when callers pass queue and TTL options.
