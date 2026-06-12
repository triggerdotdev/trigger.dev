---
"@trigger.dev/sdk": patch
---

Fix two `chat.createSession()` bugs: stopping a generation no longer wedges the run (the turn loop raced a `totalUsage` promise that never settles after a stop-abort), and continuation runs now wait for the next message instead of invoking the model with an empty prompt.
