---
area: supervisor
type: fix
---

A run whose process is killed is now only reported as out of memory when the machine actually ran out of memory. Any other kill (e.g. the machine being shut down or reclaimed) fails the attempt straight away as a crash, which is retried using your task's retry settings on the same machine size.
