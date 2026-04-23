---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Drop the pre-Sessions chat stream-ID constants from the public surface:

- `CHAT_STREAM_KEY`, `CHAT_MESSAGES_STREAM_ID`, `CHAT_STOP_STREAM_ID` are no longer exported from `@trigger.dev/sdk/ai` or `@trigger.dev/core/v3/chat-client`. Deletes `packages/trigger-sdk/src/v3/chat-constants.ts`.
- The `chat.stream.id` / `chat.messages.id` / `chat.stopSignal.id` labels still contain the same string values (`"chat"` / `"chat-messages"` / `"chat-stop"`) — now inlined as opaque breadcrumbs rather than user-consumable constants. Behavior and telemetry attrs are unchanged.

These constants only mattered before the chat.agent I/O moved onto the Session primitive — the SDK no longer writes to run-scoped `streams.writer(CHAT_STREAM_KEY, …)` / `streams.input(CHAT_*_STREAM_ID)` at all. Customers who still referenced them externally should migrate to `sessions.open(sessionId).out.writer(...)` / `sessions.open(sessionId).in.on(...)` — same primitives, now session-keyed.
