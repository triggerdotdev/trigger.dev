---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add `mockChatAgent` test harness at `@trigger.dev/sdk/ai/test` for unit-testing `chat.agent` definitions offline. Drives a real agent's turn loop without network or task runtime: send messages, actions, and stop signals via driver methods, inspect captured output chunks, and verify hooks fire. Pairs with `MockLanguageModelV3` from `ai/test` for model mocking.

Also adds `TestRunMetadataManager` to `@trigger.dev/core/v3/test` (in-memory metadata manager used by the harness), and exposes an `onWrite` hook on `TestRealtimeStreamsManager` so harnesses can react to stream writes without polling.
