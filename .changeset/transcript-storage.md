---
"@trigger.dev/sdk": minor
"@trigger.dev/core": minor
---

`chat.agent` persists a conversation through a `TranscriptStorage`: an adapter with `load` and `save` that the runtime drives after every turn, failed turn and history-changing action. The platform snapshot stays the default; bring your own to write each change to your database as it happens, with an undo arriving as one `truncateAfter` instead of a rewrite of the whole conversation.

```ts
chat.agent({
  id: "my-chat",
  storage: myTranscriptStorage,
  run: async ({ messages, signal, streamText }) =>
    streamText({ model, messages, abortSignal: signal }),
});
```

`chat.createLoadTranscriptAction(storage)` and `useLoadTranscript` read the conversation back the same way for every storage, and `runTranscriptStorageTests` from `@trigger.dev/sdk/ai/test` checks an implementation against the contract. Compaction summaries and `chat.inject` context now survive a continuation run, crash recovery runs for every agent including those that own their own context, and `hydrateMessages` is deprecated in favour of `loadContext` on a storage. The snapshot format is now version 2; older SDK versions cannot read it.
