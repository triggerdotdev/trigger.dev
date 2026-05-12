---
area: webapp
type: improvement
---

Route TTL expiration through the batch TTL path only. Removes the redundant per-run `expireRun` worker job, leaving the batch consumer as the single mechanism that flips runs to `EXPIRED` when their TTL elapses while still queued.
