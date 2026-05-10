---
"@trigger.dev/sdk": minor
---

`chat.agent` actions are no longer treated as turns. They fire `hydrateMessages` and `onAction` only — no `onTurnStart` / `prepareMessages` / `onBeforeTurnComplete` / `onTurnComplete`, no `run()`, no turn-counter increment. The trace span is named `chat action` instead of `chat turn N`.

`onAction` can now return a `StreamTextResult`, `string`, or `UIMessage` to produce a model response from the action; returning `void` (the previous and now default) is side-effect-only.

**Migration**: if you previously had `run()` branching on `payload.trigger === "action"`, return your `streamText(...)` from `onAction` instead. If you persisted in `onTurnComplete`, do that work inside `onAction`. For any other state-only action, just remove your skip-the-model workaround — the default is now correct.

```ts
// before
onAction: async ({ action }) => {
  if (action.type === "regenerate") {
    chat.store.set({ skipModelCall: false });
    chat.history.slice(0, -1);
  }
},
run: async ({ messages, signal }) => {
  if (chat.store.get()?.skipModelCall) return;
  return streamText({ model, messages, abortSignal: signal });
},

// after
onAction: async ({ action, messages, signal }) => {
  if (action.type === "regenerate") {
    chat.history.slice(0, -1);
    return streamText({ model, messages, abortSignal: signal });
  }
},
run: async ({ messages, signal }) =>
  streamText({ model, messages, abortSignal: signal }),
```
