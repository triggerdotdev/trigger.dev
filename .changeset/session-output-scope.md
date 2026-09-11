---
"@trigger.dev/sdk": patch
---

Session public tokens can now be narrowed to one stream: `read: { sessions: "chat_123:out" }` grants read access to that session's `.out` channel only, without access to the session record or its other channels.
