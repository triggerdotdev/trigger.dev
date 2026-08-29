---
"@trigger.dev/core": patch
---

Queue retrieve and list API responses now report total concurrency usage. When a queue has a `totalConcurrencyLimit`, `concurrency.total` includes the effective cap, the declared base, any active override, and how many runs are in flight across all concurrency keys.
