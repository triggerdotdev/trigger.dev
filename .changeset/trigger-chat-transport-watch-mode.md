---
"@trigger.dev/sdk": patch
---

Add `watch` option to `TriggerChatTransport` for read-only observation of an existing chat run.

When set to `true`, the transport keeps its internal `ReadableStream` open across `trigger:turn-complete` control chunks instead of closing it after each turn. This lets a single `useChat` / `resumeStream` subscription observe every turn of a long-lived agent run — useful for dashboard viewers or debug UIs that only want to watch an existing conversation as it unfolds, rather than drive it.

```tsx
const transport = new TriggerChatTransport({
  task: "my-chat-task",
  accessToken: runScopedPat,
  watch: true,
  sessions: {
    [chatId]: { runId, publicAccessToken: runScopedPat },
  },
});

const { messages, resumeStream } = useChat({ id: chatId, transport });
useEffect(() => { resumeStream(); }, [resumeStream]);
```

Non-watch transports are unaffected — the default remains `false` and existing behavior (close on turn-complete so `useChat` can flip to `"ready"` between turns) is preserved for interactive playground-style flows.
