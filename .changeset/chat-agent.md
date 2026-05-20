---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

**AI Agents** — run AI SDK chat completions as durable Trigger.dev agents instead of fragile API routes. Define an agent in one function, point `useChat` at it from React, and the conversation survives page refreshes, network blips, and process restarts.

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

const transport = useTriggerChatTransport({ task: "my-chat", accessToken, startSession });
const { messages, sendMessage } = useChat({ transport });
```

**What you get:**

- **AI SDK `useChat` integration** — a custom [`ChatTransport`](https://sdk.vercel.ai/docs/ai-sdk-ui/transport) (`useTriggerChatTransport`) plugs straight into Vercel AI SDK's `useChat` hook. Text streaming, tool calls, reasoning, and `data-*` parts all work natively over Trigger.dev's realtime streams. No custom API routes needed.
- **First-turn fast path (`chat.headStart`)** — opt-in handler that runs the first turn's `streamText` step in your warm server process while the agent run boots in parallel, cutting cold-start TTFC by roughly half (measured 2801ms → 1218ms on `claude-sonnet-4-6`). The agent owns step 2+ (tool execution, persistence, hooks) so heavy deps stay where they belong. Web Fetch handler works natively in Next.js, Hono, SvelteKit, Remix, Workers, etc.; bridge to Express/Fastify/Koa via `chat.toNodeListener`. New `@trigger.dev/sdk/chat-server` subpath.
- **Multi-turn durability via Sessions** — every chat is backed by a durable Session that outlives any individual run. Conversations resume across page refreshes, idle timeout, crashes, and deploys; `resume: true` reconnects via `lastEventId` so clients only see new chunks. `sessions.list` enumerates chats for inbox-style UIs.
- **Auto-accumulated history, delta-only wire** — the backend accumulates the full conversation across turns; clients only ship the new message each turn. Long chats never hit the 512 KiB body cap. Register `hydrateMessages` to be the source of truth yourself.
- **Lifecycle hooks** — `onPreload`, `onChatStart`, `onValidateMessages`, `hydrateMessages`, `onTurnStart`, `onBeforeTurnComplete`, `onTurnComplete`, `onChatSuspend`, `onChatResume` — for persistence, validation, and post-turn work.
- **Stop generation** — client-driven `transport.stopGeneration(chatId)` aborts mid-stream; the run stays alive for the next message, partial response is captured, and aborted parts (stuck `partial-call` tools, in-progress reasoning) are auto-cleaned.
- **Tool approvals (HITL)** — tools with `needsApproval: true` pause until the user approves or denies via `addToolApprovalResponse`. The runtime reconciles the updated assistant message by ID and continues `streamText`.
- **Steering and background injection** — `pendingMessages` injects user messages between tool-call steps so users can steer the agent mid-execution; `chat.inject()` + `chat.defer()` adds context from background work (self-review, RAG, safety checks) between turns.
- **Actions** — non-turn frontend commands (undo, rollback, regenerate, edit) sent via `transport.sendAction`. Fire `hydrateMessages` + `onAction` only — no turn hooks, no `run()`. `onAction` can return a `StreamTextResult` for a model response, or `void` for side-effect-only.
- **Typed state primitives** — `chat.local<T>` for per-run state accessible from hooks, `run()`, tools, and subtasks (auto-serialized through `ai.toolExecute`); `chat.store` for typed shared data between agent and client; `chat.history` for reading and mutating the message chain; `clientDataSchema` for typed `clientData` in every hook.
- **`chat.toStreamTextOptions()`** — one spread into `streamText` wires up versioned system [Prompts](https://trigger.dev/docs/ai/prompts), model resolution, telemetry metadata, compaction, steering, and background injection.
- **Multi-tab coordination** — `multiTab: true` + `useMultiTabChat` prevents duplicate sends and syncs state across browser tabs via `BroadcastChannel`. Non-active tabs go read-only with live updates.
- **Network resilience** — built-in indefinite retry with bounded backoff, reconnect on `online` / tab refocus / bfcache restore, `Last-Event-ID` mid-stream resume. No app code needed.

See [/docs/ai-chat](https://trigger.dev/docs/ai-chat/overview) for the full surface — quick start, three backend approaches (`chat.agent`, `chat.createSession`, raw task), persistence and code-sandbox patterns, type-level guides, and API reference.
