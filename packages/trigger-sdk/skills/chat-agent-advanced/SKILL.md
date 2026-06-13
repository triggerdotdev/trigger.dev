---
name: chat-agent-advanced
description: >
  Advanced and operational chat.agent capabilities for Trigger.dev, loaded on demand. Load this when
  working on the raw Sessions primitive (sessions / SessionHandle), a custom chat transport or the
  realtime wire protocol, durable sub-agents (AgentChat, chat.stream.writer), human-in-the-loop,
  steering, actions, background injection (chat.defer / chat.inject), fast starts (preload, Head
  Start via @trigger.dev/sdk/chat-server), context resilience (compaction, recovery boot, OOM, large
  payloads), chat.local run-scoped state, offline testing with mockChatAgent, or prerelease/version
  upgrades. For the everyday chat.agent({...}) definition and the useTriggerChatTransport happy path,
  use the authoring-chat-agent skill instead.
type: core
library: trigger.dev
sources:
  - docs/ai-chat/sessions.mdx
  - docs/ai-chat/server-chat.mdx
  - docs/ai-chat/client-protocol.mdx
  - docs/ai-chat/pending-messages.mdx
  - docs/ai-chat/actions.mdx
  - docs/ai-chat/background-injection.mdx
  - docs/ai-chat/compaction.mdx
  - docs/ai-chat/fast-starts.mdx
  - docs/ai-chat/chat-local.mdx
  - docs/ai-chat/mcp.mdx
  - docs/ai-chat/testing.mdx
  - docs/ai-chat/upgrade-guide.mdx
  - docs/ai-chat/patterns/sub-agents.mdx
  - docs/ai-chat/patterns/human-in-the-loop.mdx
  - docs/ai-chat/patterns/persistence-and-replay.mdx
  - docs/ai-chat/patterns/recovery-boot.mdx
  - docs/ai-chat/patterns/oom-resilience.mdx
  - docs/ai-chat/patterns/large-payloads.mdx
  - docs/ai-chat/patterns/version-upgrades.mdx
  - docs/ai-chat/tools.mdx
---

# chat.agent: advanced and operational

`chat.agent` is built on **Sessions**: a durable, task-bound, bi-directional I/O channel pair keyed
on a stable `externalId` (e.g. `chatId`) that outlives any single run. This skill covers the layers
beneath and around the everyday agent: the raw `sessions` API, server-side `AgentChat`, durable
sub-agents, actions / background injection, fast starts, compaction and recovery, and the wire
protocol for custom transports.

Two `chat` namespaces are easy to confuse: the agent definition imports `chat` from
`@trigger.dev/sdk/ai`; Head Start / Node-listener server entries import `chat` from
`@trigger.dev/sdk/chat-server`.

## Setup

Happy path: drive an agent from server-side code (task, webhook, or script) with `AgentChat`.

```ts
import { AgentChat } from "@trigger.dev/sdk/chat";
import type { myAgent } from "./trigger/my-agent";

const chat = new AgentChat<typeof myAgent>({ agent: "my-chat", clientData: { userId: "user_123" } });
const stream = await chat.sendMessage("Review PR #42");
const text = await stream.text();
await chat.close();
```

`sendMessage()` triggers a run on the first call, then reuses it via input streams. `ChatStream`
exposes `text()`, `result()` (`{ text, toolCalls, toolResults }`), `messages()` (UIMessage
snapshots), and the raw `.stream`. Other methods: `steer(text)`, `stop()`, `sendRaw(uiMessages)`,
`sendAction(action)`, `preload()`, `reconnect()`.

## Core patterns

### 1. Raw Sessions for non-chat, bi-directional I/O

Reach for `sessions` directly when the chat abstraction does not fit: agent inboxes, approval flows,
server-to-server pipelines. `sessions.start` is idempotent on `(env, externalId)`; `externalId`
cannot start with `session_`.

```ts
import { sessions } from "@trigger.dev/sdk";

const { id, publicAccessToken } = await sessions.start({
  type: "chat.agent",
  externalId: chatId,
  taskIdentifier: "my-chat",
  triggerConfig: { tags: [`chat:${chatId}`], basePayload: { chatId, trigger: "preload" } },
});

const session = sessions.open(chatId); // no network call; methods are lazy
await session.out.append({ kind: "message", text: "hello" });
const next = await session.in.once<MyEvent>({ timeoutMs: 30_000 });
```

`sessions.open(id).in` also has `send`, `on(handler)`, `peek`, `wait` (suspends the run, only inside
`task.run()`), and `waitWithIdleTimeout`. `.out` has `append`, `pipe`, `writer`, `read`,
`writeControl`, and `trimTo`. List with `sessions.list({ type, tag, status, ... })` (`for await`),
mutate with `sessions.update`, end with `sessions.close` (terminal, idempotent).

### 2. Durable sub-agent as a streaming tool

`AgentChat` inside an AI SDK `tool()` delegates to a durable sub-agent; its response streams as
preliminary tool results. Give the tool a `toModelOutput` so the model sees a compact summary.

```ts
import { tool } from "ai";
import { AgentChat } from "@trigger.dev/sdk/chat";
import { z } from "zod";

const researchTool = tool({
  description: "Delegate research to a specialist agent.",
  inputSchema: z.object({ topic: z.string() }),
  execute: async function* ({ topic }, { abortSignal }) {
    const chat = new AgentChat({ agent: "research-agent" });
    const stream = await chat.sendMessage(topic, { abortSignal });
    yield* stream.messages(); // UIMessage snapshots become preliminary tool results
    await chat.close();
  },
  toModelOutput: ({ output: message }) => {
    const lastText = message?.parts?.findLast((p: { type: string }) => p.type === "text") as
      | { text?: string }
      | undefined;
    return { type: "text", value: lastText?.text ?? "Done." };
  },
});
```

For a subtask exposed via `execute: ai.toolExecute(task)`, stream progress to the agent's run with
`chat.stream.writer({ target: "root" })`. `target` accepts `"self" | "parent" | "root" | <runId>`.
Inside the subtask, read context with `ai.toolCallId()` and `ai.chatContextOrThrow<typeof myChat>()`
(`{ chatId, turn, continuation, clientData }`).

```ts
import { chat, ai } from "@trigger.dev/sdk/ai";

const { waitUntilComplete } = chat.stream.writer({
  target: "root",
  execute: ({ write }) =>
    write({ type: "data-research-status", id: partId, data: { query, status: "in-progress" } }),
});
await waitUntilComplete();
```

### 3. Background injection: defer + inject

`chat.defer(promise)` runs work in parallel with streaming (all deferred promises are awaited, with a
5s timeout, before `onTurnComplete`). `chat.inject(messages)` queues `ModelMessage[]` that drain at
the next turn start or `prepareStep` boundary.

```ts
export const myChat = chat.agent({
  id: "my-chat",
  onTurnComplete: async ({ messages }) => {
    chat.defer(
      (async () => {
        const analysis = await analyzeConversation(messages);
        chat.inject([{ role: "system", content: `[Analysis]\n\n${analysis}` }]);
      })()
    );
  },
  run: async ({ messages, signal }) =>
    streamText({ ...chat.toStreamTextOptions({ registry }), messages, abortSignal: signal, stopWhen: stepCountIs(15) }),
});
```

### 4. Compaction (threshold-based)

`compaction.shouldCompact` decides when, `summarize` produces the summary that replaces the model
messages. UI messages are preserved by default (customize via `compactUIMessages`). The `prepareStep`
that performs inner-loop compaction is auto-injected by `chat.toStreamTextOptions()`; a `prepareStep`
you pass after the spread wins.

```ts
compaction: {
  shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > 80_000,
  summarize: async ({ messages }) =>
    (await generateText({
      model: anthropic("claude-haiku-4-5"),
      messages: [...messages, { role: "user", content: "Summarize concisely." }],
    })).text,
},
```

### 5. Actions: mutate state without a turn

`actionSchema` validates; `onAction` mutates via `chat.history` (`slice`, `replace`, `rollbackTo`,
`remove`, `getPendingToolCalls`, `extractNewToolResults`). Actions fire `hydrateMessages` and
`onAction` only, never `run()` or the turn hooks. Return a `StreamTextResult`, string, or `UIMessage`
to also emit a model response.

```ts
export const myChat = chat.agent({
  id: "my-chat",
  actionSchema: z.discriminatedUnion("type", [
    z.object({ type: z.literal("undo") }),
    z.object({ type: z.literal("rollback"), targetMessageId: z.string() }),
  ]),
  onAction: async ({ action }) => {
    if (action.type === "undo") chat.history.slice(0, -2);
    if (action.type === "rollback") chat.history.rollbackTo(action.targetMessageId);
  },
  run: async ({ messages, signal }) => streamText({ model: anthropic("claude-sonnet-4-5"), messages, abortSignal: signal }),
});
```

Send from the browser with `transport.sendAction(chatId, { type: "undo" })`, or server-side with
`agentChat.sendAction({ type: "rollback", targetMessageId: "msg-3" })`.

### 6. Fast starts: Head Start

`chat.headStart` (from `@trigger.dev/sdk/chat-server`, NOT `/ai`) returns a Web Fetch handler that
serves turn 1 from your own warm process, then hands off to the agent on turn 2+. Tools passed here
must be **schema-only** (a module importing `ai` + `zod` only); heavy executes stay in the task.

```ts
import { chat } from "@trigger.dev/sdk/chat-server";
import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { headStartTools } from "@/lib/chat-tools/schemas";

export const chatHandler = chat.headStart({
  agentId: "my-chat",
  run: async ({ chat: helper }) =>
    streamText({
      ...helper.toStreamTextOptions({ tools: headStartTools }),
      model: anthropic("claude-sonnet-4-6"),
      system: "You are helpful.",
      stopWhen: stepCountIs(15),
    }),
});
// Next.js: export const POST = chatHandler;  Transport: headStart: "/api/chat"
```

Node-only frameworks wrap a Web Fetch handler with `chat.toNodeListener(handler)`. Use the **same
model** on both sides to avoid a tone shift between turn 1 and turn 2+.

### 7. chat.local: init in onBoot, not onChatStart

`chat.local<T>({ id })` is module-level, shallow-proxy, run-scoped state. Initialize it in `onBoot`
(fires on every fresh worker, including continuation runs), never `onChatStart`.

```ts
const userContext = chat.local<{ name: string; plan: "free" | "pro" }>({ id: "userContext" });

export const myChat = chat.agent({
  id: "my-chat",
  onBoot: async ({ clientData }) => userContext.init({ name: "Alice", plan: "pro" }),
  run: async ({ messages, signal }) => streamText({ /* ... */ }),
});
```

### 8. Pending messages (mid-stream user input)

A message sent while a turn is streaming should NOT cancel the stream. Configure
`pendingMessages` (`shouldInject`, `prepare`, `onReceived`, `onInjected`) on the agent so the SDK's
auto-injected `prepareStep` folds them in at the next boundary. On the frontend, `usePendingMessages`
returns `pending`, `steer(text)`, `queue(text)`, and `promoteToSteering(id)`; send via
`transport.sendPendingMessage(chatId, uiMessage, metadata?)`.

### 9. Recovery and version upgrades

`onRecoveryBoot` fires only when a **partial assistant message exists on the tail** (interrupted
deploy, crash, OOM retry). It does NOT fire on `chat.requestUpgrade()`, which is a graceful exit with
no partial. `chat.requestUpgrade()` (called in `onTurnStart` / `onValidateMessages` to skip `run()`,
or in `run()` / `chat.defer()` to exit after the turn) rotates the Session's `currentRunId` to a run
on the latest deployment without a client reconnect. Pair it with a contract version on `clientData`.

```ts
const SUPPORTED_VERSIONS = new Set(["v2", "v3"]);
onTurnStart: async ({ clientData }) => {
  if (clientData?.protocolVersion && !SUPPORTED_VERSIONS.has(clientData.protocolVersion)) {
    chat.requestUpgrade();
  }
},
```

For OOM resilience, set `oomMachine` (and `machine`) on the agent so retries land on a larger preset.

### 10. Offline testing with mockChatAgent

`@trigger.dev/sdk/ai/test` runs the real turn loop in-memory. Import it **before** the agent module
so the resource catalog is installed. Drive with `sendMessage`, `sendRegenerate`, `sendAction`,
`sendStop`, `sendHeadStart`, `sendHandover`; seed state with `seedSnapshot` / `seedSessionOutTail` /
`seedSessionOutPartial` / `seedSessionInTail`; assert against `turn.chunks` and `harness.allChunks`.

```ts
import { mockChatAgent } from "@trigger.dev/sdk/ai/test"; // BEFORE the agent module
import { myChatAgent } from "./my-chat.js";

const harness = mockChatAgent(myChatAgent, { chatId: "test-1", clientData: { model } });
try {
  const turn = await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
  // assert against turn.chunks
} finally {
  await harness.close();
}
```

Options include `mode` (`"preload" | "submit-message" | "handover-prepare" | "continuation"`),
`preload`, `continuation`, `previousRunId`, `snapshot`, `taskContext`, and `setupLocals`. Set
`taskContext.ctx.attempt.number > 1` to simulate an OOM-retry attempt. `runInMockTaskContext` drives a
non-chat task offline.

### 11. Custom transport: the wire protocol

Endpoints: `POST /api/v1/sessions` (create), `GET /realtime/v1/sessions/{id}/out` (SSE),
`POST /realtime/v1/sessions/{id}/in/append`, `POST /api/v1/sessions/{id}/close`. `ChatInputChunk` is
`{ kind: "message"; payload: ChatTaskWirePayload } | { kind: "stop"; message? }`. The
`ChatTaskWirePayload` carries `chatId`, `trigger` (`submit-message | regenerate-message | preload |
close | action | handover-prepare`), `message?`, `metadata?`, `action?`, `continuation?`,
`previousRunId?`, and more. Control records are header-form: `trigger-control: turn-complete` (with
optional `public-access-token`, `session-in-event-id`) and `trigger-control: upgrade-required`. The
TS helpers `SSEStreamSubscription` and `controlSubtype(headers)` (documented in
`docs/ai-chat/client-protocol.mdx`) handle batch decoding and control-record filtering for you.

## Common mistakes

- **CRITICAL: sending a follow-up by re-POSTing `POST /api/v1/sessions`.**
  ```ts
  // Wrong - a cached re-POST silently drops basePayload.message; basePayload is trigger config, not a channel
  await fetch("/api/v1/sessions", { method: "POST", body: JSON.stringify({ ...createBody }) });
  // Correct - append to the session's input channel
  await fetch(`/realtime/v1/sessions/${id}/in/append`, { method: "POST", body: JSON.stringify({ kind: "message", payload }) });
  ```

- **Using the wrong token for `.in` / `.out`.** Use `publicAccessToken` from the create response
  body (session-scoped). The `x-trigger-jwt` response header is run-scoped and cannot subscribe.

- **Initializing `chat.local` in `onChatStart`.** It is skipped on continuation runs, so `run()`
  crashes with `chat.local can only be modified after initialization`. Init in `onBoot`.

- **`chat.defer` for the message-history write.** A mid-stream refresh would read `[]`. `await` that
  write inline before the model streams; reserve `chat.defer` for analytics, audit, cache warming.

- **Giving the HITL tool an `execute`.** `streamText` calls it immediately. Leave it execute-less;
  the frontend supplies the answer via `addToolOutput` + `sendAutomaticallyWhen`.

- **Declaring sub-agent / heavy tools only on `streamText`.** Also declare them on
  `chat.agent({ tools })` (or pass to `convertToModelMessages(uiMessages, { tools })` in a custom
  agent) so `toModelOutput` re-applies on every turn.

- **Importing heavy-execute tools into the Head Start route module.** This is a build-time import
  chain problem; runtime strip helpers do not fix it. Keep schemas in an `ai` + `zod`-only module.

- **Returning a megabyte tool output on the stream.** One `tool-output-available` record over ~1 MiB
  throws `ChatChunkTooLargeError`. Persist to your store, write the row first, then emit only an id.

- **Setting `X-Peek-Settled: 1` on the active-send path.** It races the new turn's first chunk and
  closes the stream early. Use it only on reconnect-on-reload paths.

> Note on docs vocabulary: agent-side examples in some docs still use the legacy
> `trigger:turn-complete` chunk type. That is the agent-emit vocabulary. A custom **reader** must
> filter on the `trigger-control` header, not on `chunk.type`.
>
> MCP-driven agent chats (`list_agents`, `start_agent_chat`, `send_agent_message`,
> `close_agent_chat`) are MCP server tools used from Claude Code / Cursor, not importable SDK
> functions. See `/mcp-tools#agent-chat-tools`.

## References

- `authoring-chat-agent` skill - the everyday `chat.agent({...})` definition, lifecycle hooks, and
  the `useTriggerChatTransport` happy path. Start there before reaching for this skill.
- `realtime-and-frontend` skill - Realtime hooks and frontend streaming beyond the chat transport.
- `authoring-tasks` skill - base `task()` semantics, `ctx`, and standard lifecycle hooks.

Reference docs ship beside this skill in the same package, read them locally (no network), pinned to your installed version. The `sources:` frontmatter above lists every doc this skill draws from, all under `@trigger.dev/sdk/docs/ai-chat/` (including `patterns/`). For HITL, sessions, and sub-agents start with `sessions.mdx`, `server-chat.mdx`, `client-protocol.mdx`, `patterns/human-in-the-loop.mdx`, `patterns/sub-agents.mdx`.

## Version

This skill is bundled inside `@trigger.dev/sdk` and read directly from `node_modules`, so it always matches your installed SDK version (see the adjacent `package.json`). The full documentation for these APIs ships alongside it under `@trigger.dev/sdk/docs/`.
