---
area: webapp
type: feature
---

Mollifier API mutations on buffered runs: tag, metadata, replay, reschedule, cancel, and idempotency-key reset via a buffer-snapshot fallback. When a mutation races a mid-drain run, the wait-and-bounce loop watches the buffer entry in Redis (cheap) and reads the primary exactly once for the actual mutation, instead of polling the writer on a fixed cadence; polls use jittered exponential backoff.
