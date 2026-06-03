---
"@trigger.dev/core": patch
---

Coerce numeric `concurrencyKey` values to string at the API boundary across `tasks.trigger`, `tasks.batchTrigger`, and the Phase-2 streaming batch endpoint.
