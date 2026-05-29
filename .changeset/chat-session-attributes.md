---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Stamp `gen_ai.conversation.id` (the chat id) on every span and metric emitted from inside a `chat.task` or `chat.agent` run. Lets you filter dashboard spans, runs, and metrics by the chat conversation that produced them — independent of the run boundary, so multi-run chats correlate cleanly. No code changes required on the user side.
