---
"@trigger.dev/sdk": patch
---

Fix a `chat.agent` message-loss race where sending a message right after an action (such as an undo) could drop the follow-up's response from the UI until a refresh.
