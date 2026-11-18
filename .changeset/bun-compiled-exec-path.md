---
"trigger.dev": patch
---

Fix `child_process.fork()` and `spawn(process.execPath, ...)` in compiled `bun-1.4` deploys. They started the run worker again instead of Bun, so the child never ran and the task hung. `process.execPath` now points at the image's `bun` binary, as it does in uncompiled deploys.
