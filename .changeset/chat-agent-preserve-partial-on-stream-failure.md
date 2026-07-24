---
"@trigger.dev/sdk": patch
---

Preserve the partial assistant message when a chat turn's model stream fails mid-response. `chat.agent` now passes the recovered partial to `onTurnComplete`, and `chat.createSession`'s `turn.complete()` keeps it before rethrowing, instead of dropping the streamed-so-far output.
