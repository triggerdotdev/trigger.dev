---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Fix `chat.agent` and `chat.createSession` dropping user messages when several arrive during a single turn, most visibly a message sent to a chat whose run had ended vanishing while the continuation run replayed already-answered messages. Continuation boots now resume from the correct session.in cursor, and every message buffered during a turn is dispatched instead of only the first.
