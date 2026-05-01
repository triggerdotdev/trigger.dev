---
"@trigger.dev/sdk": patch
---

AI SDK `tool()` helpers for Trigger subtasks:

- `ai.toolExecute(task)` — pass Trigger's subtask/metadata wiring as the `execute` handler to AI SDK `tool()` while you define `description` and `inputSchema` yourself. `ai.tool()` is now refactored to share the same internal handler.
- `ai.tool(task)` (`toolFromTask`) aligns with AI SDK `ToolSet`: Zod-backed tasks use static `tool()`; returns are asserted as `Tool & ToolSet[string]`. Minimum `ai` devDependency raised to `^6.0.116` so emitted types resolve the same `ToolSet` as apps on AI SDK 6.0.x — avoids cross-version `ToolSet` mismatches in monorepos.
