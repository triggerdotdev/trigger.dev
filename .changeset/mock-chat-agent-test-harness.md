---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Offline test harness for `chat.agent` — drive a real agent's turn loop in-process, no network, no task runtime. Pairs with `MockLanguageModelV3` from `ai/test` for model mocking.

**`@trigger.dev/sdk/ai/test`:**

- `mockChatAgent(agent, options)` — drives a chat.agent definition end-to-end. Send messages, actions, and stop signals via driver methods; inspect captured output chunks; verify hooks fire.
- `setupLocals` option — pre-seed `locals` (database clients, service stubs) before the agent's `run()` starts, so hooks read the test instance via `locals.get()` without leaking through untrusted `clientData`.

**`@trigger.dev/core/v3/test`:**

- `runInMockTaskContext(fn, options)` — broader test harness for any task code. Installs in-memory managers for `locals`, `lifecycleHooks`, `runtime`, `inputStreams`, and `realtimeStreams`, plus a mock `TaskContext`. Drivers send data into input streams and inspect chunks written to output streams.
- `TestRunMetadataManager` — in-memory metadata manager used by the harness.
- `TestRealtimeStreamsManager.onWrite` hook — react to stream writes without polling.
- `drivers.locals.set()` exposed for direct DI.
