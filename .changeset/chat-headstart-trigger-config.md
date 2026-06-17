---
"@trigger.dev/sdk": patch
---

Add `triggerConfig` support to `chat.headStart()` and `chat.openSession()`, so the auto-triggered handover-prepare run inherits tags, queue, machine, and other session trigger options the same way `chat.createStartSessionAction()` does. The `chat:{chatId}` tag is prepended automatically.

```ts
export const POST = chat.headStart({
  agentId: "my-agent",
  triggerConfig: { tags: ["org:acme"], queue: "chat" },
  run: async ({ chat }) => streamText({ ...chat.toStreamTextOptions(), model }),
});
```

Because the session is created once on the first head-start turn and is idempotent on the chat id, this is the only place to set those options for a head-start chat's lifetime. `chat.createStartSessionAction()` now also forwards `maxDuration`, `region`, and `lockToVersion` so both session entry points stay consistent.
