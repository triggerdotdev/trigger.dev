---
area: webapp
type: fix
---

Concurrency sweeper now removes the message from the worker queue list
when acking marked runs, eliminating stale `messageKey` tombstones that
produced "Failed to dequeue message from worker queue" errors when
consumed by a later BLPOP.
