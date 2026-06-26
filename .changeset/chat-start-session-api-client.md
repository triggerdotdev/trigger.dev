---
"@trigger.dev/sdk": patch
---

`chat.createStartSessionAction` now accepts an `apiClient` option, so you can scope a chat session start to a specific environment's API config (`baseURL` / `accessToken`) without setting a global `TRIGGER_SECRET_KEY`. Useful when one server starts chats across more than one environment.

```ts
const startSession = chat.createStartSessionAction("my-chat", {
  apiClient: { baseURL, accessToken },
});

await startSession({ chatId, clientData });
```
