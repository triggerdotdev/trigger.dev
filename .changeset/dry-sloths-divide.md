---
"@trigger.dev/sdk": patch
---

Add `chat.withUIMessage<TUIMessage>()` for typed AI SDK `UIMessage` in chat task hooks, optional factory `streamOptions` merged with `uiMessageStreamOptions`, and `InferChatUIMessage` helper. Generic `ChatUIMessageStreamOptions`, compaction, and pending-message event types. `usePendingMessages` accepts a UI message type parameter; re-export `InferChatUIMessage` from `@trigger.dev/sdk/chat/react`.
