---
"@trigger.dev/core": patch
---

Reject overlong `idempotencyKey` values at the API boundary so they no longer trip an internal size limit on the underlying unique index and surface as a generic 500. Inputs are capped at 2048 characters — well above what `idempotencyKeys.create()` produces (a 64-character hash) and above any realistic raw key. Applies to `tasks.trigger`, `tasks.batchTrigger`, `batch.create` (Phase 1 streaming batches), `wait.createToken`, `wait.forDuration`, and the input/session stream waitpoint endpoints. Over-limit requests now return a structured 400 instead.
