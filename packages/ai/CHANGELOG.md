# @trigger.dev/ai

## 4.3.3

### Added

- Introduced a new `@trigger.dev/ai` package.
- Added `ai.tool(...)` and `ai.currentToolOptions()` helpers for AI SDK tool ergonomics.
- Added `TriggerChatTransport` / `createTriggerChatTransport(...)` for AI SDK `useChat()` integrations powered by Trigger.dev tasks and Realtime Streams v2.
- Added rich default chat payload typing (`chatId`, `trigger`, `messageId`, `messages`, request context) and mapper hooks for custom payloads.
- Added support for async payload mappers, async trigger option resolvers, and async `onTriggeredRun` callbacks.
- Added support for tuple-style header input normalization and typing.
- Added reconnect lifecycle handling that cleans run state after completion/error and gracefully returns `null` when reconnect cannot be resumed.
