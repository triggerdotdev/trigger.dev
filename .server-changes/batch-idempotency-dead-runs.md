---
area: webapp
type: fix
---

Fix `batchTrigger` returning a stale failed run when its idempotency key points at a run that crashed, timed out, or otherwise failed. The key is now cleared and a fresh run triggered, matching single-`trigger` behaviour
