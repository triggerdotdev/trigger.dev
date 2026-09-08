---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

`chat.agent`: a run that recovers a session with more than one in-flight user message no longer drops the unanswered ones if it restarts mid-recovery. Recovered messages now hold the resume cursor until each has been answered, so a restart re-answers the rest instead of resuming past them. Previously the cursor could advance past messages that were only held in memory, so a crash before they were dispatched lost them.
