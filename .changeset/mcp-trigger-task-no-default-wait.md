---
"trigger.dev": patch
---

The MCP server no longer tells the AI agent to wait for a run to complete after every `trigger_task` call. Waiting is now opt-in: the agent only waits when you ask it to (for example "trigger and then wait for it to finish"). This avoids burning tokens polling runs you didn't need to block on and keeps responses clearer.
