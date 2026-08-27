---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

A message that arrives mid-turn and is not injected into that turn is now answered as the next turn, instead of being dropped. This is what the `pendingMessages` docs have always described, and it applies to the default too: configuring `pendingMessages` without a `shouldInject` declines every batch, which previously meant every mid-turn message was lost with no error at either end.

```ts
chat.agent({
  id: "my-chat",
  pendingMessages: {
    onReceived: ({ message }) => logger.info("arrived mid-turn", { id: message.id }),
    // Only interrupt once the agent has started calling tools.
    shouldInject: ({ steps }) => steps.length > 0,
  },
  run: async ({ messages, signal }) =>
    streamText({
      model,
      messages,
      abortSignal: signal,
      // Required for injection. Without it nothing injects, and every
      // mid-turn message is answered as the next turn instead.
      ...chat.toStreamTextOptions(),
    }),
});
```

A declined message keeps its place in the queue, so it survives a crash and is answered by whichever run picks the conversation up. An injected one is consumed at the moment it is injected, so it is never also answered as a later turn.
