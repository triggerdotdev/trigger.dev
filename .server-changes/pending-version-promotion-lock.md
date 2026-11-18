---
area: webapp
type: fix
---

A run released from waiting for a version is no longer occasionally left queued with nothing to pick it up when a worker dequeues it at the same moment.
