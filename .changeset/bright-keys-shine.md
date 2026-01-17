---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Expose user-provided idempotency key and scope in task context. `ctx.run.idempotencyKey` now returns the original key passed to `idempotencyKeys.create()` instead of the hash, and `ctx.run.idempotencyKeyScope` shows the scope ("run", "attempt", or "global").
