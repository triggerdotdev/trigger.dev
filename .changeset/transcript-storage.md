---
"@trigger.dev/sdk": minor
"@trigger.dev/core": minor
---

`chat.agent` persists a conversation through a `TranscriptStorage`: an adapter with `load` and `save` that the runtime drives after every turn, failed turn and history-changing action. The platform snapshot stays the default; bring your own to write the conversation to your database as it happens. Each save carries both the changes since the last one (so a row store writes only what changed, and an undo is one `truncateAfter`) and the whole transcript as it now stands (so a document store writes it as-is with no state of its own).

```ts
chat.agent({
  id: "my-chat",
  storage: myTranscriptStorage,
  run: async ({ messages, signal, streamText }) =>
    streamText({ model, messages, abortSignal: signal }),
});
```

`chat.createLoadTranscriptAction(storage)` and `useLoadTranscript` read the conversation back the same way for every storage, and `runTranscriptStorageTests` from `@trigger.dev/sdk/ai/test` checks an implementation against the contract.

Compaction summaries and `chat.inject` context now survive a continuation run, and crash recovery runs for every agent, including one that owns its own context. `hydrateMessages` is deprecated in favour of `loadContext` on a storage. The snapshot format is now version 2, which older SDK versions cannot read.
