---
"@trigger.dev/sdk": patch
---

Add an `onEvent` callback to `TriggerChatTransport` / `useTriggerChatTransport` that emits typed lifecycle events for sends, stream connects, first chunk, and turn completion. Send-success metrics, time-to-first-token, and "sent but never answered" watchdogs become a few lines of client code.

```ts
onEvent: (event) => {
  if (event.type === "message-sent") metrics.timing("chat.send_ms", event.durationMs);
  if (event.type === "first-chunk") metrics.timing("chat.ttft_ms", event.sinceSendMs ?? 0);
},
```
