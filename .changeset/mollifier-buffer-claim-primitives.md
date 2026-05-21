---
"@trigger.dev/redis-worker": patch
---

Add pre-gate idempotency-claim primitives to `MollifierBuffer`: `claimIdempotency` (atomic SETNX-with-TTL claim returning `claimed` / `pending` / `resolved`), `publishClaim` (publish winning runId so waiters resolve), `releaseClaim` (DEL claim on pipeline error), `readClaim` (used by the webapp's wait/poll loop). Uses a separate key namespace `mollifier:claim:{env}:{task}:{key}` to keep isolated from the B6a buffer-side `mollifier:idempotency:...` lookup.
