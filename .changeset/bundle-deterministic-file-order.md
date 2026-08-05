---
"trigger.dev": patch
---

Fix non-deterministic task-to-file attribution when multiple tasks share an output bundle. `Object.entries` iteration order is not guaranteed, so tasks defined in imported files could be attributed to the wrong source file. Files are now sorted by entry path before registration.
