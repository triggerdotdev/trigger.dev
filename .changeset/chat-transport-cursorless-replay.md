---
"@trigger.dev/sdk": patch
---

`TriggerChatTransport` no longer replays the previous answer when a chat is sent to or reconnected without a saved `lastEventId`, for example after a page reload that doesn't restore it. Only the current turn's answer reaches the UI, and a reload mid-answer resumes it live. With older agents that write no turn markers, the answer can arrive when its turn completes rather than streaming, and with the oldest, which record no input cursor, a send made while the agent is idle can still get the previous answer.
