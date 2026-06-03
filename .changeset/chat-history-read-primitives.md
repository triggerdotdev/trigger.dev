---
"@trigger.dev/sdk": minor
---

Add read primitives to `chat.history` for HITL flows: `getPendingToolCalls()`, `getResolvedToolCalls()`, `extractNewToolResults(message)`, `getChain()`, and `findMessage(messageId)`. These lift the accumulator-walking logic that customers building human-in-the-loop tools were re-implementing into the SDK.

Use `getPendingToolCalls()` to gate fresh user turns while a tool call is awaiting an answer. Use `extractNewToolResults(message)` to dedup tool results when persisting to your own store — the helper returns only the parts whose `toolCallId` is not already resolved on the chain.

```ts
const pending = chat.history.getPendingToolCalls();
if (pending.length > 0) {
  // an addToolOutput is expected before a new user message
}

onTurnComplete: async ({ responseMessage }) => {
  const newResults = chat.history.extractNewToolResults(responseMessage);
  for (const r of newResults) {
    await db.toolResults.upsert({ id: r.toolCallId, output: r.output, errorText: r.errorText });
  }
};
```
