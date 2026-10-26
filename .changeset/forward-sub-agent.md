---
"@trigger.dev/sdk": patch
---

Stream a sub-agent's reply through a parent tool call with `chat.forwardSubAgent`. Each chunk is written to the parent chat once and the tool resolves with the sub-agent's final message, so streaming a sub-agent costs bytes in proportion to its reply. Yielding `stream.messages()` snapshots resends the whole message on every chunk, which grows with the square of the reply.

```ts
execute: async ({ topic }, { toolCallId, abortSignal }) => {
  const stream = await researcher.sendMessage(topic, { abortSignal });
  return await chat.forwardSubAgent(stream, { toolCallId });
},
```

Render it while it runs with `useSubAgentMessages()` from `@trigger.dev/sdk/chat/react` (or `createSubAgentMessages()` outside React).
