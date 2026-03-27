---
"@trigger.dev/sdk": patch
---

Add `ai.toolExecute(task)` so you can pass Trigger's subtask/metadata wiring as the `execute` handler to AI SDK `tool()` while defining `description` and `inputSchema` yourself. Refactors `ai.tool()` to share the same internal handler.
