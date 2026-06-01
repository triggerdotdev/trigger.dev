---
"@trigger.dev/sdk": patch
---

Add a `tools` option to `chat.agent`. Declaring your tools here threads them into the SDK's internal `convertToModelMessages`, so each tool's `toModelOutput` is re-applied when prior-turn history is re-converted.

```ts
chat.agent({
  tools: { readFile, search },
  run: async ({ messages, tools, signal }) =>
    streamText({ model, messages, tools, abortSignal: signal }),
});
```

Also exports `InferChatUIMessageFromTools<typeof tools>` to derive the chat `UIMessage` type (typed tool parts) directly from a tool set.
