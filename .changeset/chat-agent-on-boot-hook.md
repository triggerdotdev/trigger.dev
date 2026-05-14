---
"@trigger.dev/sdk": minor
---

Adds `onBoot` to `chat.agent` — a lifecycle hook that fires once per worker process picking up the chat. Runs for the initial run, preloaded runs, AND reactive continuation runs (post-cancel, crash, `endRun`, `requestUpgrade`, OOM retry), before any other hook. Use it to initialize `chat.local`, open per-process resources, or re-hydrate state from your DB on continuation — anywhere the SAME run picking up after suspend/resume isn't enough.

```ts
const userContext = chat.local<{ name: string; plan: string }>({ id: "userContext" });

export const myChat = chat.agent({
  id: "my-chat",
  onBoot: async ({ clientData, continuation }) => {
    const user = await db.user.findUnique({ where: { id: clientData.userId } });
    userContext.init({ name: user.name, plan: user.plan });
  },
  run: async ({ messages, signal }) =>
    streamText({ model: openai("gpt-4o"), messages, abortSignal: signal }),
});
```

If you previously initialized `chat.local` in `onChatStart`, move it to `onBoot` — `onChatStart` is once-per-chat and won't fire on a continuation, leaving `chat.local` uninitialized when `run()` tries to use it. See the upgrade guide for the migration pattern.
