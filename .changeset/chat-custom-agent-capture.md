---
"@trigger.dev/sdk": patch
---

Custom chat agent loops get two ergonomic wins for owning the turn loop.

`chat.writeTurnComplete()` now returns the turn boundary's resume cursors (`lastEventId` for the output stream and `sessionInEventId` for the input stream), so you can persist them straight from the task instead of round-tripping them back from the client.

```ts
const { lastEventId, sessionInEventId } = await chat.writeTurnComplete();
await db.chats.update(chatId, { lastEventId, sessionInEventId });
```

`chat.pipeAndCapture()` no longer throws when a stream is stopped or fails. It now returns a `PipeAndCaptureResult` whose `message` holds any partial output captured before the stop or failure, alongside a typed `status` (`"complete" | "aborted" | "error"`) and, on failure, the `error`. Read the message off the result:

```ts
const { message, status, error } = await chat.pipeAndCapture(result, { signal });
if (message) conversation.addResponse(message);
if (status === "error") logger.error("turn failed", { error });
```

Note: `pipeAndCapture` previously resolved to `UIMessage | undefined`. Update call sites to read `.message` from the returned result.
