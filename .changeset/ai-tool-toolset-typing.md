---
"@trigger.dev/sdk": patch
---

Align `ai.tool()` (`toolFromTask`) with the AI SDK `ToolSet` shape: Zod-backed tasks use static `tool()`; returns are asserted as `Tool & ToolSet[string]`. Raise the SDK's minimum `ai` devDependency to `^6.0.116` so emitted types resolve the same `ToolSet` as apps on AI SDK 6.0.x (avoids cross-version `ToolSet` mismatches in monorepos).

