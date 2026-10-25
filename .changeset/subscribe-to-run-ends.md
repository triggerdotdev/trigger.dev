---
"@trigger.dev/core": patch
---

`runs.subscribeToRun` now ends after the run completes. The `for await` loop exits right after the update with the final status, and the subscription stops its connection, so a script that subscribes to a run exits on its own. Pass `stopOnCompletion: false` to keep the subscription open after completion.
