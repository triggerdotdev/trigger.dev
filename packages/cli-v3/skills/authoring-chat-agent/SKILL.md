---
name: authoring-chat-agent
description: >
  Author and run a durable AI chat agent with chat.agent from @trigger.dev/sdk/ai: the per-turn
  run loop, why you MUST spread ...chat.toStreamTextOptions() first, returning a StreamTextResult
  vs calling chat.pipe(), the two server actions (chat.createStartSessionAction +
  auth.createPublicToken), and wiring useChat to useTriggerChatTransport. Load this when building,
  modifying, or debugging a chat backend (the agent task or its lifecycle hooks) or its React
  transport, when declaring typed tools or custom data parts, or when migrating a plain AI SDK
  streamText route to chat.agent.
type: core
library: trigger.dev
library_version: "{{TRIGGER_SDK_VERSION}}"
sources:
  - docs/ai-chat/overview.mdx
  - docs/ai-chat/quick-start.mdx
  - docs/ai-chat/how-it-works.mdx
  - docs/ai-chat/backend.mdx
  - docs/ai-chat/frontend.mdx
  - docs/ai-chat/reference.mdx
  - docs/ai-chat/types.mdx
  - docs/ai-chat/tools.mdx
  - docs/ai-chat/lifecycle-hooks.mdx
  - docs/ai-chat/error-handling.mdx
---

# Authoring a chat agent

A `chat.agent` runs an entire conversation as one long-lived Trigger.dev task. It wakes when a
message arrives, freezes when none do, and in-memory state survives page refreshes, deploys, idle
gaps, and crashes. Your code is the loop you would write anyway: messages in, `streamText` out.
There are no API routes. The frontend talks to the agent through a `TriggerChatTransport`, so
history accumulates server-side and the client ships only the new message each turn.

Works with Vercel AI SDK v5, v6, or v7. On v7 also install `@ai-sdk/otel` so model calls are traced
(the SDK registers it for you).

## Setup

Three pieces: the agent task, two server actions, and the frontend transport.

### 1. Define the agent

```ts trigger/chat.ts
import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const myChat = chat.agent({
  id: "my-chat",
  run: async ({ messages, signal }) =>
    streamText({
      // Spread this FIRST. See "Common mistakes".
      ...chat.toStreamTextOptions(),
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    }),
});
```

`run` receives `messages` already converted to `ModelMessage[]` (the SDK converts the frontend's
`UIMessage[]` for you) plus a `signal` that aborts on stop or cancel. Returning the
`StreamTextResult` auto-pipes it to the frontend.

### 2. Add two server actions

Both run on your server, so the browser never holds your environment secret key. This is also
where per-user / per-plan authorization and any paired DB writes live.

```ts app/actions.ts
"use server";
import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";

// Creates the Session + first run, returns a session PAT. Idempotent on (env, chatId).
export const startChatSession = chat.createStartSessionAction("my-chat");

// Pure mint. The transport calls this on 401/403 to refresh an expired token.
export async function mintChatAccessToken(chatId: string) {
  return auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  });
}
```

### 3. Wire the frontend

```tsx app/components/chat.tsx
"use client";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { myChat } from "@/trigger/chat";
import { mintChatAccessToken, startChatSession } from "@/app/actions";

export function Chat() {
  const transport = useTriggerChatTransport<typeof myChat>({
    task: "my-chat", // typeof myChat gives compile-time task-id validation
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) => startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, stop, status } = useChat({ transport });
  const [input, setInput] = useState("");
  // render messages, a form that calls sendMessage({ text: input }),
  // and a Stop button (onClick={stop}) while status === "streaming".
}
```

The transport is memoized (created once, reused across renders). Passing `typeof myChat` flows the
agent's message type through `useChat`.

## Core patterns

### 1. Return vs pipe

Return the `streamText` result from `run` for the simple case. When `streamText` is called deep
inside nested helpers, call `await chat.pipe(result)` from anywhere in the task instead, and let
`run` resolve `void`.

```ts
export const agentChat = chat.agent({
  id: "agent-chat",
  run: async ({ messages }) => {
    await runAgentLoop(messages); // don't return; pipe inside
  },
});

async function runAgentLoop(messages: ModelMessage[]) {
  const result = streamText({
    ...chat.toStreamTextOptions(),
    model: anthropic("claude-sonnet-4-5"),
    messages,
  });
  await chat.pipe(result); // works from anywhere in the task
}
```

### 2. Typed tools (declare on config AND spread back)

Declare tools on `chat.agent({ tools })`, read them back typed from the `run()` payload, and pass
that set to `chat.toStreamTextOptions({ tools })`. One declaration flows everywhere.

```ts
import { tool, stepCountIs } from "ai";
import { z } from "zod";

const tools = {
  searchDocs: tool({
    description: "Search the docs.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => searchIndex(query),
  }),
};

export const myChat = chat.agent({
  id: "my-chat",
  tools, // so toModelOutput survives across turns
  run: async ({ messages, tools, signal }) =>
    streamText({
      ...chat.toStreamTextOptions({ tools }), // same set, handed back typed
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    }),
});
```

`tools` also accepts a function `(event) => ToolSet` resolved per turn, where `event` carries
`chatId`, `turn`, `continuation`, and `clientData`.

### 3. Custom data parts (persisted vs transient)

`data-*` parts written via `chat.response.write()` in `run()` (or `writer.write()` in hooks)
persist into `responseMessage.parts` and surface in `onTurnComplete`. Add `transient: true` to
stream them without persisting. Writes via `chat.stream` are always ephemeral.

```ts
// In run() - persists, surfaces in onTurnComplete's responseMessage
chat.response.write({ type: "data-context", data: { searchResults } });

// In a hook via writer - streams but does NOT persist
writer.write({ type: "data-progress", id: "search", data: { percent: 50 }, transient: true });
```

### 4. Custom UIMessage type, client data, and builder hooks

For typed `data-*` parts or a tool map, build the agent through `chat.withUIMessage<T>()` and
`chat.withClientData({ schema })`. Builder methods chain in any order; builder hooks run before the
matching task hook. `streamOptions` becomes the default `uiMessageStreamOptions` (shallow-merged,
agent wins).

```ts
export const myChat = chat
  .withUIMessage<MyChatUIMessage>({ streamOptions: { sendReasoning: true } })
  .withClientData({ schema: z.object({ userId: z.string() }) })
  .agent({
    id: "my-chat",
    tools: myTools,
    onTurnStart: async ({ uiMessages, writer }) => {
      writer.write({ type: "data-turn-status", data: { status: "preparing" } });
    },
    run: async ({ messages, tools, signal }) =>
      streamText({ ...chat.toStreamTextOptions({ tools }), model, messages, abortSignal: signal }),
  });
```

Build `MyChatUIMessage` as `UIMessage<unknown, MyDataTypes, InferUITools<typeof tools>>` (or, for
tools only, `InferChatUIMessageFromTools<typeof tools>` from `@trigger.dev/sdk/ai`). On the
frontend, narrow `useChat` with `InferChatUIMessage<typeof myChat>` from `@trigger.dev/sdk/chat/react`.

### 5. Lifecycle hooks and stop

`chat.agent` accepts hooks that fire in a fixed per-turn order:

```text
onValidateMessages -> hydrateMessages -> onChatStart (chat's first message only)
  -> onTurnStart -> run() -> onBeforeTurnComplete -> onTurnComplete
```

`onBoot` fires once per worker process (every fresh boot, including continuation runs) and is where
`chat.local`, DB connections, and per-process state belong. `onChatStart` fires only on the chat's
first message. Suspend/resume use `onChatSuspend` / `onChatResume`. Config options include
`tools`, `clientDataSchema`, `maxTurns` (100), `turnTimeout` ("1h"), `idleTimeoutInSeconds` (30),
`uiMessageStreamOptions`, and `exitAfterPreloadIdle`. There is no generic `retry`; `chat.agent`
runs with `maxAttempts: 1` internally.

Stop is load-bearing: the `signal` passed to `run` aborts on stop or cancel. Forward it as
`abortSignal` to `streamText`, or the Stop button updates the UI while the model keeps generating
server-side.

```ts
run: async ({ messages, signal }) =>
  streamText({ ...chat.toStreamTextOptions(), model, messages, abortSignal: signal, stopWhen: stepCountIs(15) });
```

### 6. Migrating from a plain AI SDK `streamText` route

There is no API route in this model. The transport replaces the route round-trip, so:

- Delete the route handler. Move per-request auth into the two server actions from Setup step 2.
- Move the `streamText` call into `run`. It already receives pre-converted `ModelMessage[]`.
- Return the `StreamTextResult` (it auto-pipes) and add `...chat.toStreamTextOptions()` first.
- On the client, swap the `api` URL for `useTriggerChatTransport`; `useChat` stays the same shape.

## Common mistakes

- **CRITICAL: forgetting `...chat.toStreamTextOptions()`.**
  ```ts
  // Wrong - compaction / steering / background injection silently no-op
  return streamText({ model, messages, abortSignal: signal });
  // Correct - spread FIRST so explicit overrides win
  return streamText({ ...chat.toStreamTextOptions(), model, messages, abortSignal: signal });
  ```
  It wires the `prepareStep` callback behind compaction, mid-turn steering, and background
  injection, injects the system prompt from `chat.prompt()`, resolves the registry model, and adds
  telemetry. Omitting it makes all of those silently no-op with no error.

- **Declaring tools only on `streamText`.** Also declare them on `chat.agent({ tools })`, read them
  back from `run`, and pass `chat.toStreamTextOptions({ tools })`. Otherwise each tool's
  `toModelOutput` runs on turn 1 but is dropped when history is re-converted on later turns.

- **Not forwarding `signal` for stop.** Without `abortSignal: signal`, Stop updates the UI but the
  model keeps generating server-side.

- **Initializing `chat.local` in `onChatStart`.** Initialize it in `onBoot`. `onChatStart` fires
  once per chat, so continuation runs skip it and crash with
  `chat.local can only be modified after initialization`. `onBoot` fires on every fresh worker.

- **Minting tokens in the browser.** Never expose the environment secret key client-side. Mint via
  the two server actions; the transport calls them.

- **Clearing `lastEventId` on `chat.endRun()`.** Keep the cursor for the Session lifetime; clear it
  only when the Session itself closes. It is sessionId-keyed, so clearing forces a resubscribe from
  `seq_num=0` that can hit the prior turn's stale `turn-complete` and close the stream empty.

- **Returning the raw error from `uiMessageStreamOptions.onError`.** It leaks internals (keys,
  stack traces). Return a sanitized string instead.

## References

- `chat-agent-advanced` skill - lifecycle hooks in depth, sessions, raw-task primitives
  (`chat.createSession`, `chat.customAgent`, `chat.stream`), compaction, HITL approvals, recovery.
- `realtime-and-frontend` skill - Realtime hooks and frontend streaming beyond the chat transport.
- `authoring-tasks` skill - base `task()` semantics, `ctx`, and standard lifecycle hooks.
- Docs: /ai-chat/quick-start, /ai-chat/backend, /ai-chat/tools, /ai-chat/types, /ai-chat/frontend

## Version

Generated for `@trigger.dev/sdk` `{{TRIGGER_SDK_VERSION}}`. Re-run the trigger.dev skills installer
after upgrading.
