---
"@trigger.dev/sdk": patch
---

Steering messages are now kept in the conversation when you drive turns yourself with `chat.createSession()` or `chat.MessageAccumulator`. Previously a message that arrived mid-answer shaped that answer and then existed nowhere: it was missing from `turn.uiMessages`, so an app persisting from there never stored it, missing from `turn.messages`, so every later turn answered as though it had never been sent, and it was not queued as its own turn either. It now lands in both, the same way it does on `chat.agent`.
