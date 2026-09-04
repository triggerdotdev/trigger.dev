---
"@trigger.dev/sdk": minor
---

Actions can now become turns. `onAction` edits history with `chat.history`; to answer after the edit, return `chat.turn()` and a turn runs on the edited history with everything a turn has: the agent's system prompt and tools, steering, compaction, injected instructions, `onTurnStart` and `onTurnComplete`, and persistence. A regenerate is `chat.history.slice(0, -1); return chat.turn();`.

```ts
onAction: async ({ action }) => {
  if (action.type === "regenerate") {
    chat.history.slice(0, -1);
    return chat.turn();
  }
  if (action.type === "undo") chat.history.slice(0, -2); // edit only
},
```

Returning a `StreamTextResult`, `string` or `UIMessage` from `onAction` is no longer supported and now fails with an error pointing to `chat.turn()`. A response produced that way skipped every turn guarantee, and its delivery to the browser was unreliable: the frontend never read the stream `transport.sendAction` returned, so a regenerate that appeared to work on the server did not render. The `onAction` event no longer carries `streamText` or `tools`, since the handler no longer calls the model.

History edits made by an action are still persisted as before: platform-managed snapshots are written after the edit, and apps with their own store mirror the edit themselves.
