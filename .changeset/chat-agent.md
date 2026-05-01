---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

Run AI chats as durable Trigger.dev tasks. Define the agent in one function, wire `useChat` to it from React, and the conversation survives page refreshes, network blips, and process restarts — with built-in support for tools, HITL approvals, multi-turn state, and stop-mid-stream cancellation.

```ts
import { chat } from "@trigger.dev/sdk/ai";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export const myChat = chat.agent({
  id: "my-chat",
  run: async ({ messages, signal }) =>
    streamText({ model: openai("gpt-4o"), messages, abortSignal: signal }),
});
```

```tsx
import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";

const transport = useTriggerChatTransport({ task: "my-chat", accessToken });
const { messages, sendMessage } = useChat({ transport });
```

Lifecycle hooks (`onPreload`, `onTurnStart`, `onTurnComplete`, etc.) cover the common needs around persistence, validation, and post-turn work. `chat.store` gives you a typed shared-data slot the agent and client both read and write. `chat.endRun()` exits cleanly when the agent decides it's done. The transport's `watch` mode lets a dashboard tab observe a run without driving it.

Drops the pre-Sessions chat stream constants (`CHAT_STREAM_KEY`, `CHAT_MESSAGES_STREAM_ID`, `CHAT_STOP_STREAM_ID`) — migrate to `sessions.open(id).out` / `.in`.
