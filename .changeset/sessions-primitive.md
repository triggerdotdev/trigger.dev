---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add Sessions — a durable, task-bound, bidirectional channel pair that outlives any single run. One identifier (your `externalId`), many runs over time, with a stable `.in` channel clients can write to and a stable `.out` channel they can subscribe to. Powers `chat.agent` (separate changeset), and unblocks anything that needs "resume tomorrow" or "approval loop" workflows.

```ts
const session = await sessions.create({ externalId: chatId, taskIdentifier: "my-task" });
await session.in.send({ kind: "message", payload: "..." });
for await (const chunk of session.out.read()) { /* ... */ }
```

Inside the task, `.in.wait()` / `.waitWithIdleTimeout()` suspends the run on a session-stream waitpoint until the next record arrives. `.out.append` / `.pipe` / `.writer` produce records via direct-to-S2 writes.
