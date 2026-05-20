---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Unit-test `chat.agent` definitions offline with `mockChatAgent` from `@trigger.dev/sdk/ai/test`. Drives a real agent's turn loop in-process — no network, no task runtime — so you can send messages, actions, and stop signals via driver methods, inspect captured output chunks, and verify hooks fire. Pairs with `MockLanguageModelV3` from `ai/test` for model mocking. `setupLocals` lets you pre-seed `locals` (DB clients, service stubs) before `run()` starts.

The broader `runInMockTaskContext` harness it's built on lives at `@trigger.dev/core/v3/test` — useful for unit-testing any task code, not just chat.
