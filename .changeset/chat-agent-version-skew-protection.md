---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat sessions now stay on the deployment that matched the app build that started them, so a conversation keeps talking to the agent version its release shipped with across every turn, idle suspend and recovery. The id is resolved wherever you start the session, exactly as it is for `trigger()`, so a chat picks up whatever your app already sends when it triggers a task, with no chat-specific setup. If your app sends no id, nothing changes: chats run on the current version as they do today.

```ts
// Opt a single chat out of pinning:
export const startChatSession = chat.createStartSessionAction<typeof myChat>("my-chat", {
  triggerConfig: { externalDeploymentId: null },
});
```

Messages sent while a chat waits on a deployment that is still building are stored and answered once it lands, and the transport emits a `run-pending-version` event so your UI can say so. `chat.requestUpgrade()` now clears the session's pin so the handoff can reach a new version, and accepts `{ externalDeploymentId }` to move to a specific one.
