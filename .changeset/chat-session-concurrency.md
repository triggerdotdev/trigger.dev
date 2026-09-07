---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Chat agents can now scope concurrency per session. Pass `concurrencyKey` (for example your chat or tenant ID) and trigger-time named limits via `triggerConfig.concurrency` when starting a chat session, from `chat.createStartSessionAction`, the `AgentChat` client, or a handover. Keys are never defaulted, so a session without one shares the task's keyless pool.

```ts
const start = chat.createStartSessionAction("support-chat", {
  triggerConfig: { concurrencyKey: user.id },
});
```
