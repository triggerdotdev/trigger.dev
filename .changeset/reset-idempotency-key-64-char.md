---
"@trigger.dev/core": patch
---

`idempotencyKeys.reset()` now works when your idempotency key is itself 64 characters long (for example if you use a hash of your own as the key). Previously any 64-character key was assumed to be already hashed, so passing one along with a `scope` silently ignored the scope and the reset never found a matching run. Keys returned by `idempotencyKeys.create()` continue to be reset exactly as before.
