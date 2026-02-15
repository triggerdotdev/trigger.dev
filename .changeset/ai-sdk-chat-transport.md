---
"@trigger.dev/sdk": minor
---

Add AI SDK chat transport integration via two new subpath exports:

**`@trigger.dev/sdk/chat`** (frontend, browser-safe):
- `TriggerChatTransport` — custom `ChatTransport` for the AI SDK's `useChat` hook that runs chat completions as durable Trigger.dev tasks
- `createChatTransport()` — factory function

```tsx
import { useChat } from "@ai-sdk/react";
import { TriggerChatTransport } from "@trigger.dev/sdk/chat";

const { messages, sendMessage } = useChat({
  transport: new TriggerChatTransport({
    task: "my-chat-task",
    accessToken,
  }),
});
```

**`@trigger.dev/sdk/ai`** (backend, extends existing `ai.tool`/`ai.currentToolOptions`):
- `chatTask()` — pre-typed task wrapper with auto-pipe support
- `pipeChat()` — pipe a `StreamTextResult` or stream to the frontend
- `CHAT_STREAM_KEY` — the default stream key constant
- `ChatTaskPayload` type

```ts
import { chatTask } from "@trigger.dev/sdk/ai";
import { streamText, convertToModelMessages } from "ai";

export const myChatTask = chatTask({
  id: "my-chat-task",
  run: async ({ messages }) => {
    return streamText({
      model: openai("gpt-4o"),
      messages: convertToModelMessages(messages),
    });
  },
});
```
