---
"@trigger.dev/sdk": patch
---

`chat.agent` now passes `chatId`, `turn` and `clientData` to the callbacks an agent can call a model from, so a mock model injected through `clientData` reaches them. The compaction `summarize` that runs through `chat.MessageAccumulator.prepareStep()` and a `chat.createSession` turn's `prepareStep()`, `onCompacted`, `onValidateMessages`, and the `pendingMessages` `onReceived` and `onInjected` callbacks previously lacked it. The `mockChatAgent` turn methods (`sendMessage`, `sendRegenerate`, `sendAction`) now also wait for `onTurnComplete` and the transcript save to finish, so tests can assert on what those hooks recorded without a sleep.
