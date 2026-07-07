---
"@trigger.dev/sdk": patch
---

Add an `onEvent` observability callback to `TriggerChatTransport` / `useTriggerChatTransport` that emits typed lifecycle events: `message-sent` and `message-send-failed` (durable send outcomes with source and duration), `stream-connected`, `first-chunk`, `turn-completed`, and `stream-error`. Together these make send-success metrics, time-to-first-token, and "sent but never answered" watchdogs a few lines of client code.

```ts
const transport = useTriggerChatTransport({
  task: "my-chat",
  accessToken,
  onEvent: (event) => {
    if (event.type === "message-sent") {
      metrics.timing("chat.send_duration_ms", event.durationMs);
    }
  },
});
```
