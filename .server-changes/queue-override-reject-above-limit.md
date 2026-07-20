---
area: webapp
type: breaking
---

Setting a queue's concurrency limit above the environment limit is now rejected with a clear error instead of being silently capped. Existing overrides are unaffected.
