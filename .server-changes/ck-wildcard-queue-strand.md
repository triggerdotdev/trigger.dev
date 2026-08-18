---
area: webapp
type: fix
---

Using `*` as a concurrency key no longer stops a queue from being processed. Triggering a single run with that key could leave the whole queue stalled, including runs using other concurrency keys on it, until something else was triggered on the same queue.
