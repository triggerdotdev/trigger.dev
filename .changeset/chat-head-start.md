---
"@trigger.dev/sdk": minor
---

Add `chat.headStart` — an opt-in fast-path that runs the first turn's `streamText` step in your warm Next.js / Hono / Workers / Express handler while the trigger agent run boots in parallel. Cold-start TTFC drops by ~50% on the first message; the agent owns step 2+ (tool execution, persistence, hooks) so heavy deps stay where they belong.

```ts
// app/api/chat/route.ts (Next.js / any Web Fetch framework)
import { chat } from "@trigger.dev/sdk/chat-server";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { headStartTools } from "@/lib/chat-tools-schemas"; // schema-only

export const POST = chat.headStart({
  agentId: "ai-chat",
  run: async ({ chat: chatHelper }) =>
    streamText({
      ...chatHelper.toStreamTextOptions({ tools: headStartTools }),
      model: openai("gpt-4o-mini"),
      system: "You are a helpful AI assistant.",
    }),
});
```

```tsx
// browser — opt in by pointing the transport at your handler
const transport = useTriggerChatTransport({
  task: "ai-chat",
  accessToken,
  headStart: "/api/chat", // first-turn-only; turn 2+ bypasses the endpoint
});
```

For Node-only frameworks (Express, Fastify, Koa, raw `node:http`) use `chat.toNodeListener(handler)` to bridge the Web Fetch handler to `(req, res)`. Adds a new `@trigger.dev/sdk/chat-server` subpath; bundle stays Web Fetch–only with no `node:*` imports.
