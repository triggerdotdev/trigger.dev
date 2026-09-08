---
"@trigger.dev/sdk": patch
---

Server-side `AgentChat` streams now reconnect when the connection drops mid-turn instead of ending with a truncated reply, and a turn that still cannot be resumed ends with an error rather than a silent truncation.
