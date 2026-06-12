---
"@trigger.dev/sdk": patch
---

Three fixes for custom agent loops (`chat.customAgent`, `chat.createSession`, and hand-rolled `MessageAccumulator` loops):

- Continuation runs no longer replay already-answered user messages into the first turn. The `.in` resume cursor is now seeded before any listener attaches (the same boot logic `chat.agent` uses), so a chat that continues after a cancel, crash, or upgrade only sees genuinely new messages.
- Steering a hand-rolled loop mid-stream no longer wipes the in-flight assistant response. `chat.pipeAndCapture` now stamps a server-generated message id on the stream, so a `prepareStep` injection keeps the partial text instead of replacing the message.
- Task-backed tools (`ai.toolExecute`) now work from custom agent loops: the parent's session is threaded to the child run, so child tasks can stream progress into the chat with `chat.stream.writer({ target: "root" })` instead of failing with "session handle is not initialized".
