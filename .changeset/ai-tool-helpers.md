---
"@trigger.dev/sdk": patch
---

Add `ai.toolExecute(task)` so you can wire a Trigger subtask in as the `execute` handler of an AI SDK `tool()` while defining `description` and `inputSchema` yourself — useful when you want full control over the tool surface and just need Trigger's subtask machinery for the body.

```ts
const myTool = tool({
  description: "...",
  inputSchema: z.object({ ... }),
  execute: ai.toolExecute(mySubtask),
});
```

`ai.tool(task)` (`toolFromTask`) keeps doing the all-in-one wrap and now aligns its return type with AI SDK's `ToolSet`. Minimum `ai` peer raised to `^6.0.116` to avoid cross-version `ToolSet` mismatches in monorepos.
