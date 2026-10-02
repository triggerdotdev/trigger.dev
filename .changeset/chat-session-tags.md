---
"@trigger.dev/sdk": patch
---

`chat.createStartSessionAction`, `chat.headStart` and `chat.startHeadStart` now accept `tags` for the Session itself, so chat sessions can be filtered by tag on the Sessions page. `triggerConfig.tags` still tags the session's runs.

```ts
await startChatSession({ chatId, clientData, tags: [`org:${org.slug}`, `user:${user.id}`] });
```
