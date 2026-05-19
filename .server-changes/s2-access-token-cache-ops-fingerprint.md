---
area: webapp
type: fix
---

Include the S2 access-token scope fingerprint in its cache key so a scope change in code (e.g. adding a new op) auto-invalidates pre-deploy cached tokens instead of returning stale ones for up to 24h.
