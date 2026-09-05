---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

End a chat conversation from inside the agent with `chat.close({ reason })`. The session row is closed, further sends are refused with HTTP 409, and the run exits without scheduling a continuation, so a budget cap, a completed goal, or a signed-out user can stop the conversation rather than only the current run.

```ts
chat.agent({
  id: "budgeted-agent",
  run: async ({ messages, signal }) =>
    streamText({ model: openai("gpt-4o"), messages, abortSignal: signal }),
  onBeforeTurnComplete: async ({ chatId }) => {
    if (await overBudget(chatId)) {
      chat.close({ reason: "Monthly budget reached" });
    }
  },
});
```

The current turn still streams in full. Decide the close before the turn ends (`run()`, `prepareStep`, `onBeforeTurnComplete`) so the closed state rides out on that turn's final record and the user sees it as soon as the answer finishes. `TriggerChatTransport` picks the close up from the response stream or from a refused send, exposes it as `transport.sessionStatus(chatId)` plus `transport.sessionClosedReason(chatId)`, and stops sending and reconnecting. Closing a session from outside with `sessions.close()` now also reaches a live run, so an idle or suspended agent exits on its next wake instead of waiting out its idle timeout. Writes to a closed session's named side channels are refused with the same 409.
