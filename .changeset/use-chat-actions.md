---
"@trigger.dev/sdk": minor
---

Actions are sent through `useChat` so a turn that follows one renders like any turn. `TriggerChatTransport` recognises `body.action` on a `useChat` request and sends it as an action, so `sendMessage(undefined, { body: { action } })` or `regenerate({ body: { action } })` sends the action and `useChat` owns the response: it streams into the message list, `status` and `error` behave as for a message, and `stop` works. `useChatActions({ sendMessage })` in `@trigger.dev/sdk/chat/react` is a two-line convenience over that.

```tsx
const { sendMessage } = useChat({ id: chatId, transport });
const { sendAction } = useChatActions({ sendMessage });
sendAction({ type: "regenerate" });
```

Previously the frontend docs said `useChat` consumed the stream `transport.sendAction` returns; it never did, so an action's answer was never rendered by an app following them. `transport.sendAction` is unchanged for callers outside `useChat` and still returns a stream the caller must read.
