---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

`chat.agent` — durable AI chat as Trigger.dev tasks, with frontend wiring for the AI SDK's `useChat` hook. Built on top of the new Sessions primitive (separate changeset).

## SDK

**`@trigger.dev/sdk/ai`** (backend):

- `chat.agent({ id, run, ... })` — durable agent with full lifecycle hooks (`onPreload`, `onChatStart`, `onTurnStart`, `onBeforeTurnComplete`, `onTurnComplete`, `onCompacted`, `onValidateMessages`, `onAction`, `hydrateMessages`, `hydrateStore`). Auto-pipes a returned `streamText` result to the frontend.
- `chat.customAgent({ id, run })` — minimal protocol-level escape hatch; same session binding as `chat.agent`.
- `chat.withUIMessage<TUIMessage>().agent({...})` — generic-typed agent for custom `UIMessage` subtypes (typed `data-*` parts, tool maps, etc.). Ships `InferChatUIMessage`, generic `ChatUIMessageStreamOptions`, generic compaction + pending-message event types. `usePendingMessages` accepts a UI-message type parameter; `InferChatUIMessage` re-exported from `@trigger.dev/sdk/chat/react`.
- `chat.pipe(stream)` — pipe a `StreamTextResult` or stream from anywhere inside the agent.
- `chat.endRun()` — exit the run after the current turn completes, without the upgrade-required signal that `chat.requestUpgrade()` sends. Use for one-shot responses, agent-finished-its-work, or budget-exhausted exits.
- `chat.store` — typed, bidirectional shared data slot. `set` / `patch` (RFC 6902) / `get` / `onChange`; per-run scoped. Emits `store-snapshot` / `store-delta` chunks on the chat output stream. `hydrateStore` config for restore-on-continuation; `incomingStore` wire field for client-set data at turn start.
- `chat.sessionId` — getter for the friendlyId (`session_*`) of the run's backing Session. Throws outside chat.agent / chat.customAgent.
- `TaskRunContext` (`ctx`) on every lifecycle event, `CompactedEvent`, and `ChatTaskRunPayload`. `TaskRunContext` re-exported from `@trigger.dev/sdk`.
- `finishReason` on `TurnCompleteEvent` and `BeforeTurnCompleteEvent` — surfaces AI SDK's `FinishReason` (`"stop" | "tool-calls" | "length" | ...`) so hooks can distinguish a normal end from a paused-on-tool-call HITL flow. Undefined for manual `pipeChat()` or aborted streams.
- `ChatTaskPayload.trigger` includes `"action"`. Actions short-circuit the LLM call cleanly: `if (trigger === "action") return;`.

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

**`@trigger.dev/sdk/chat`** (frontend / browser):

- `TriggerChatTransport` — `ChatTransport` for `useChat`. Backed by Sessions: posts to `session.in/append`, subscribes to `session.out` SSE.
- `watch: true` option — read-only observation of an existing run. Keeps the internal stream open across `trigger:turn-complete` markers so a single `useChat` / `resumeStream` subscription observes every turn of a long-lived agent. Useful for dashboard viewers / debug UIs. Default `false` preserves interactive behavior.
- `RenewRunAccessTokenParams` includes the durable `sessionId` alongside `chatId` + `runId`. Renew handlers should mint with `read:sessions:{sessionId}` + `write:sessions:{sessionId}` scopes; renewing without session scopes throws the transport into a 401 loop on the first append after expiry.
- Run-scoped PAT renewal (`renewRunAccessToken`); fail fast on 401/403 for SSE without retry backoff. `isTriggerRealtimeAuthError` exported for auth-error detection.
- `transport.preload(chatId)` no longer calls `apiClient.createSession` from the browser — the server action returns `sessionId` in its result, matching how `sendMessages` already worked. Browser deployments using the `triggerTask` callback path therefore no longer need `write:sessions` on any browser-side token.
- `reconnectToStream` no longer requires callers to persist an `isStreaming` flag in `ChatSession` state — the short-circuit only triggers on explicit `isStreaming === false`.

**`@trigger.dev/sdk/chat/react`**:

- `useTriggerChatTransport({ task, accessToken, ... })` — memoized hook wrapping `TriggerChatTransport` for `useChat`.

## chat.agent fixes folded in

- `chat.customAgent` now binds the session handle (previously only `chat.agent` set up the per-run `SessionHandle`, so any custom agent that called `chat.messages.*`, `chat.stream.*`, `chat.createSession`, or `chat.createStopSignal` threw `chat.agent session handle is not initialized`). `chat.customAgent` now wraps the user's `run` and opens the session via `payload.sessionId ?? payload.chatId` before invoking it.
- Stop mid-stream no longer hangs the turn loop. The AI SDK's `runResult.totalUsage` promise can stay unresolved indefinitely on aborted Anthropic streams; the await is now raced against a 2s timeout so a stuck `totalUsage` falls through to a non-fatal "usage unknown" path and the turn finalizes correctly.

## Cleanup

The pre-Sessions chat stream-ID constants are gone:

- `CHAT_STREAM_KEY`, `CHAT_MESSAGES_STREAM_ID`, `CHAT_STOP_STREAM_ID` are no longer exported from `@trigger.dev/sdk/ai` or `@trigger.dev/core/v3/chat-client`.
- `packages/trigger-sdk/src/v3/chat-constants.ts` deleted.
- The labels still contain the same string values — they're now opaque breadcrumbs rather than user-consumable constants. Behavior and telemetry attrs unchanged.

These constants only mattered before chat.agent moved onto the Session primitive. Customers who referenced them externally should migrate to `sessions.open(sessionId).out.writer(...)` / `sessions.open(sessionId).in.on(...)` — same primitives, now session-keyed.

## Core

- New `chat.store` chunk types and `applyChatStorePatch` helper exported from `@trigger.dev/core/v3/chat-client`.
- `RenewRunAccessTokenParams` payload extended with `sessionId`.
