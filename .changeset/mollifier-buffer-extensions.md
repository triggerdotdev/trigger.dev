---
"@trigger.dev/redis-worker": minor
---

Mollifier buffer extensions: idempotency dedup, an atomic `mutateSnapshot` API, metadata CAS, claim primitives, and a `MollifierSnapshot` type. The buffer's Redis client now reconnects with jittered backoff so a fleet of clients doesn't stampede Redis in lockstep after a blip.
