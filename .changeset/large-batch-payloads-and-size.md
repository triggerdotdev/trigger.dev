---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Large batch payloads now offload to object storage instead of riding inline in the trigger request. `batchTrigger` and `batchTriggerAndWait` (and the by-id and by-task variants) offload any per-item payload over 128KB before sending, the same way single `trigger` and `triggerAndWait` already do, so a big batch no longer blows past the API body limit.
