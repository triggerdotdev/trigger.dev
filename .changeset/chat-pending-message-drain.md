---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` and `chat.createSession` permanently dropping user messages when several arrived during a single turn: every buffered message is now dispatched as its own turn instead of only the first.
