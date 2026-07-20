---
area: webapp
type: breaking
---

Setting a queue's concurrency limit higher than the environment limit is now rejected with a clear error instead of being silently reduced to the maximum. This applies to the queue concurrency override API and the dashboard. Existing overrides are unaffected — the change only affects new attempts that exceed the environment limit.
