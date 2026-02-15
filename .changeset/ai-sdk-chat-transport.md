---
"@trigger.dev/ai": minor
---

New package: `@trigger.dev/ai` — AI SDK integration for Trigger.dev

Provides `TriggerChatTransport`, a custom `ChatTransport` implementation for the Vercel AI SDK that bridges `useChat` with Trigger.dev's durable task execution and realtime streams.

**Frontend usage:**
```tsx
import { useChat } from "@ai-sdk/react";
import { TriggerChatTransport } from "@trigger.dev/ai";

const { messages, sendMessage } = useChat({
  transport: new TriggerChatTransport({
    accessToken: publicAccessToken,
    taskId: "my-chat-task",
  }),
});
```

**Backend task:**
```ts
import { task, streams } from "@trigger.dev/sdk";
import { streamText, convertToModelMessages } from "ai";
import type { ChatTaskPayload } from "@trigger.dev/ai";

export const myChatTask = task({
  id: "my-chat-task",
  run: async (payload: ChatTaskPayload) => {
    const result = streamText({
      model: openai("gpt-4o"),
      messages: convertToModelMessages(payload.messages),
    });
    const { waitUntilComplete } = streams.pipe("chat", result.toUIMessageStream());
    await waitUntilComplete();
  },
});
```

Also exports `createChatTransport()` factory function and `ChatTaskPayload` type for task-side typing.
