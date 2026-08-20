---
"@trigger.dev/sdk": patch
---

`chat.inject()` with `role: "system"` now works. It previously put the system message into the conversation, which AI SDK 7 rejects for every provider — the next turn died with a generic "An error occurred." and persisted an empty assistant message, so the agent looked like it had simply stopped answering. System-role context is now appended to the model's instructions, which is also the only way to inject context the agent will treat as trusted.
