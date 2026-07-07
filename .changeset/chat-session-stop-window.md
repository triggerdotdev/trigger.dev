---
"@trigger.dev/sdk": patch
---

Fix `chat.createSession` swallowing a message sent shortly after stopping a turn: the turn's message listener now detaches when the stream settles, so those messages run as the next turn.
