---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` on AI SDK 7 sending the model the same input on every step. Once a step's `prepareStep` returned messages (a steering message, a mid-turn `chat.inject`, context compaction, or your own `prepareStep`), later steps no longer included the newest tool results, so the model kept repeating the same tool call until the step limit.

If you call `chat.compact()` from your own `prepareStep`, pass it the `responseMessages` your `prepareStep` receives (`chat.compact(messages, steps, { ...options, responseMessages })`) so steps after a compaction are rebuilt correctly on AI SDK 7.
