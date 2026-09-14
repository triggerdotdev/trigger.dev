---
"@trigger.dev/sdk": patch
---

`chat.agent`: a `chat.history` edit made in `onTurnComplete` after a failed turn is now kept. Previously the edit was applied only when the turn succeeded, so a failure record or a card the hook closed on the error path never reached the transcript.
