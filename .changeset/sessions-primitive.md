---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

**Sessions** — a durable, run-aware stream channel keyed on a stable `externalId`. A Session is the unit of state that owns a multi-run conversation: messages flow through `.in`, responses through `.out`, both survive run boundaries. Sessions back the new `chat.agent` runtime, and you can build on them directly for any pattern that needs durable bi-directional streaming across runs.

```ts
import { sessions, tasks } from "@trigger.dev/sdk";

// Trigger a task and subscribe to its session output in one call
const { runId, stream } = await tasks.triggerAndSubscribe("my-task", payload, {
  externalId: "user-456",
});

for await (const chunk of stream) {
  // ...
}

// Enumerate existing sessions (powers inbox-style UIs without a separate index)
for await (const s of sessions.list({ type: "chat.agent", tag: "user:user-456" })) {
  console.log(s.id, s.externalId, s.createdAt, s.closedAt);
}
```

See [/docs/ai-chat/overview](https://trigger.dev/docs/ai-chat/overview) for the full surface — Sessions powers the durable, resumable chat runtime described there.
