# @trigger.dev/ai

AI SDK integrations for Trigger.dev.

## What this package includes

- `TriggerChatTransport` for wiring AI SDK `useChat()` to Trigger.dev tasks + Realtime Streams v2
- `createTriggerChatTransport(...)` factory helper
- `ai.tool(...)` and `ai.currentToolOptions()` helpers for tool-calling flows
- helper types such as `TriggerChatSendMessagesOptions`, `TriggerChatReconnectOptions`, and `TriggerChatHeadersInput`

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

Incoming `request.headers` can be supplied as a plain object, `Headers`, or tuple arrays.

Typed request option helper aliases are exported:

- `TriggerChatSendMessagesOptions`
- `TriggerChatReconnectOptions`
- `TriggerChatHeadersInput`
- `TriggerChatTransportError` / `TriggerChatOnError`
- `normalizeTriggerChatHeaders(...)`

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
the chat stream is consumed. Callback failures are ignored so chat streaming can continue.

You can optionally provide `onError` to observe non-fatal transport errors
(for example callback failures or reconnect setup issues).

The callback receives:

- `phase`: `"payloadMapper" | "triggerOptions" | "triggerTask" | "streamSubscribe" | "onTriggeredRun" | "consumeTrackingStream" | "reconnect"`
- `chatId`
- `runId` (may be `undefined` before a run is created)
- `error`

Cleanup operations against custom `runStore` implementations are best-effort. If store cleanup
fails, the original transport error is still preserved and surfaced. The transport also attempts
both cleanup steps (`set` inactive state and `delete`) even if one of them fails.

## Reconnect semantics

- `reconnectToStream({ chatId })` resumes only while a stream is still active.
- Once a stream completes or errors, its run state is cleaned up and reconnect returns `null`.
- If reconnect finds stale inactive state and run-store cleanup fails, `onError` receives a
  `"reconnect"` phase event and reconnect still returns `null`.
- If inactive-state cleanup fails, later reconnect calls retry that cleanup until it succeeds.
- If `onError` is not provided, reconnect still returns `null` and continues operating
  without surfacing callback events.
- Provide a custom `runStore` if you need state shared across processes/instances.

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
