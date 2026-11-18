---
area: webapp
type: fix
---

A task that returns while its run is resuming from a wait it did not await (for example a wait raced against a timeout or an abort signal) can now fail right away with an error that says so. Before, the run stayed in an executing state until its heartbeat timed out, and could then be reported as out of memory. This is off by default: set `RUN_ENGINE_STALE_COMPLETION_MODE=enforce` on the webapp to switch it on.
