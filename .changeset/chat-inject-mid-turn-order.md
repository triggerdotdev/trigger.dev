---
"@trigger.dev/sdk": patch
---

Fix `chat.inject` messages added from a tool mid-turn being saved before the assistant's response. They now stay after the tool result, where the model saw them, so the next turn keeps the same prompt prefix. If you roll `@trigger.dev/sdk` back to an earlier version, chats saved by this version lose these mid-turn `chat.inject` messages from the model's context, though the chat history shown in the UI keeps them.
