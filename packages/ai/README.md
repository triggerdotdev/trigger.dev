# @trigger.dev/ai

AI SDK integrations for Trigger.dev.

## What this package includes

- `TriggerChatTransport` for wiring AI SDK `useChat()` to Trigger.dev tasks + Realtime Streams v2
- `createTriggerChatTransport(...)` factory helper
- `ai.tool(...)` and `ai.currentToolOptions()` helpers for tool-calling flows

## Install

```bash
npm add @trigger.dev/ai ai
```

## `useChat()` transport example

```tsx
import { useChat } from "@ai-sdk/react";
import { TriggerChatTransport } from "@trigger.dev/ai";
import { aiStream } from "@/app/streams";

export function Chat({ triggerToken }: { triggerToken: string }) {
  const chat = useChat({
    transport: new TriggerChatTransport({
      task: "ai-chat",
      stream: aiStream,
      accessToken: triggerToken,
    }),
  });

  return (
    <button
      onClick={function onClick() {
        chat.sendMessage({ text: "Hello" });
      }}
    >
      Send
    </button>
  );
}
```

## Task payload typing

Use `TriggerChatTransportPayload<UIMessage>` in your task for the default rich payload:

- `chatId`
- `trigger`
- `messageId`
- `messages`
- `request` (`headers`, `body`, `metadata`)

```ts
import type { TriggerChatTransportPayload } from "@trigger.dev/ai";
import { UIMessage } from "ai";

type Payload = TriggerChatTransportPayload<UIMessage>;
```

## `ai.tool(...)` example

```ts
import { ai } from "@trigger.dev/ai";
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

const searchTask = schemaTask({
  id: "search",
  schema: z.object({ query: z.string() }),
  run: async function run(payload) {
    return { result: payload.query };
  },
});

const tool = ai.tool(searchTask);
```

`@trigger.dev/sdk/ai` remains available for backwards compatibility, but `@trigger.dev/ai` is the recommended import path.
