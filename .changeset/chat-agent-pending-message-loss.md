---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Fix `chat.agent` and `chat.createSession` dropping user messages when several arrive during a single turn. The most visible case: sending a message to a chat whose run had ended could make the message vanish. The continuation run replayed already-answered messages, silently discarded the new one, and a refresh lost it entirely. Turns delivered while the run was suspended now advance the session.in resume cursor (so continuation boots no longer replay processed messages), and every message buffered during a turn is dispatched as its own turn instead of only the first.
