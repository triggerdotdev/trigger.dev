---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Fix idempotency key metadata (original key + scope) being silently dropped when a single run creates more than 1000 idempotency keys. The in-process catalog that maps a key's hash back to its original key/scope is no longer bounded to 1000 entries, so `idempotencyKeys.create()` results retain their metadata regardless of how many are created in a run. The catalog is now cleared at each run boundary so it does not accumulate across warm-start runs.
