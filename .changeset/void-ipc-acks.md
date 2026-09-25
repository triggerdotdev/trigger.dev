---
"@trigger.dev/core": patch
---

Fix a ~6-second delay between a task finishing and its run completing (and a ~31-second delay when cancelling a run) in projects that use zod 4.4 or newer.
