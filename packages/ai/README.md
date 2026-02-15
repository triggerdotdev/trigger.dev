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

## Custom payload mapping

If your task expects a custom payload shape, provide `payloadMapper` (sync or async):

```ts
import { TriggerChatTransport } from "@trigger.dev/ai";
import type { UIMessage } from "ai";

const transport = new TriggerChatTransport<
  UIMessage,
  { prompt: string; tenantId: string | undefined }
>({
  task: "ai-chat-custom",
  accessToken: "pk_...",
  payloadMapper: async function payloadMapper(request) {
    await Promise.resolve();

    const firstPart = request.messages[0]?.parts[0];

    return {
      prompt: firstPart && firstPart.type === "text" ? firstPart.text : "",
      tenantId:
        typeof request.request.body === "object" && request.request.body
          ? (request.request.body as Record<string, string>).tenantId
          : undefined,
    };
  },
});
```

`triggerOptions` can also be a function (sync or async), which gives you access to
`chatId`, messages, and request context to compute queueing/idempotency options.

## Optional persistent run state

`TriggerChatTransport` supports custom run stores (including async implementations) to persist reconnect state:

```ts
import type { TriggerChatRunState, TriggerChatRunStore } from "@trigger.dev/ai";

class MemoryStore implements TriggerChatRunStore {
  private runs = new Map<string, TriggerChatRunState>();

  async get(chatId: string) {
    return this.runs.get(chatId);
  }

  async set(state: TriggerChatRunState) {
    this.runs.set(state.chatId, state);
  }

  async delete(chatId: string) {
    this.runs.delete(chatId);
  }
}
```

`onTriggeredRun` can also be async, which is useful for persisting run IDs before
the chat stream is consumed.

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
