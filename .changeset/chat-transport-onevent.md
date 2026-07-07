---
"@trigger.dev/sdk": patch
---

Add an `onEvent` observability callback to `TriggerChatTransport` / `useTriggerChatTransport` that emits typed lifecycle events: `message-sent` and `message-send-failed` (durable send outcomes with source, duration, payload size, and the append's idempotency key), `stream-connected`, `first-chunk` and `turn-completed` (with built-in time-to-first-token and turn latency via `sinceSendMs`), and `stream-error`. Send-success metrics, TTFT, and "sent but never answered" watchdogs become a few lines of client code.

```ts
const transport = useTriggerChatTransport({
  task: "my-chat",
  accessToken,
  onEvent: (event) => {
    if (event.type === "message-sent") {
      metrics.timing("chat.send_duration_ms", event.durationMs);
    }
    if (event.type === "first-chunk") {
      metrics.timing("chat.ttft_ms", event.sinceSendMs ?? 0);
    }
    if (event.type === "message-send-failed") {
      metrics.increment("chat.send_failed", { status: event.status });
    }
  },
});
```
