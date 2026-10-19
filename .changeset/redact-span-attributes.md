---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Redact span content before it leaves the worker. `telemetry.spanProcessors` in `trigger.config.ts` runs your own span processors ahead of every export, to Trigger.dev and to your own exporters, so you can redact or drop span content before it reaches the run trace. `chat.agent` also takes a `telemetry` option to stop recording the user's message and `clientData` on its spans.

```ts
export default defineConfig({
  telemetry: { spanProcessors: [new MyRedactingSpanProcessor()] },
});

chat.agent({
  id: "my-chat",
  telemetry: { recordUserMessage: false, recordClientData: false },
  run: async ({ messages, signal, streamText }) =>
    streamText({ model, messages, abortSignal: signal }),
});
```
