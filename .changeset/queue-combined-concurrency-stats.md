---
"@trigger.dev/core": patch
---

Queue retrieve and list API responses now report combined concurrency usage. When a queue has a `combinedConcurrencyLimit`, `concurrency.combined` includes the effective cap, the declared base, any active override, and how many runs are in flight across all concurrency keys.
