---
"@trigger.dev/sdk": patch
---

`chat.agent` now accepts only two kinds of message from a chat client: user messages, and answers to tool calls the agent made. A tool approval or tool output is merged onto the stored call it answers and runs with the input from the agent's own history, so a client can't add tool calls or change a call's input. `chat.headStart` drops tool calls from the history the client sends, and `upsertIncomingMessage` only adds user messages.
