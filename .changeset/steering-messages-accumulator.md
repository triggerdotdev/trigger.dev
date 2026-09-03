---
"@trigger.dev/sdk": patch
---

Steering messages injected mid-answer are now part of the conversation your hooks see. Previously they reached the model and the browser but not `onTurnComplete`, so an app storing its own transcript lost the instruction the answer was shaped by. It vanished from the conversation on reload, and later turns had no record of it.
