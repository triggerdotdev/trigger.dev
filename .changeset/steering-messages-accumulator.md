---
"@trigger.dev/sdk": patch
---

Steering messages injected mid-answer are now part of the conversation your hooks see. Previously they reached the model and the browser but not `onTurnComplete`, so an app storing its own transcript lost the instruction the answer was shaped by. It vanished from the conversation on reload, and later turns had no record of it.

If you worked around this by saving steering messages as they arrive, in `pendingMessages.onReceived` for example, that write now duplicates the one you get from `newUIMessages`. Drop it, or skip messages you have already stored.
