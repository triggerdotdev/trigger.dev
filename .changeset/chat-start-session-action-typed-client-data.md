---
"@trigger.dev/sdk": patch
---

Type `chat.createStartSessionAction` against your chat agent so `clientData` is typed end-to-end on the first turn:

```ts
import { chat } from "@trigger.dev/sdk/ai";
import type { myChat } from "@/trigger/chat";

export const startChatSession = chat.createStartSessionAction<typeof myChat>("my-chat");

// In the browser, threaded from the transport's typed startSession callback:
const transport = useTriggerChatTransport<typeof myChat>({
  task: "my-chat",
  startSession: ({ chatId, clientData }) =>
    startChatSession({ chatId, clientData }),
  // ...
});
```

`ChatStartSessionParams` gains a typed `clientData` field — folded into the first run's `payload.metadata` so `onPreload` / `onChatStart` see the same shape per-turn `metadata` carries via the transport. The opaque session-level `metadata` field is unchanged.
