# chat.agent on Sessions — architecture reference

Snapshot of how `chat.agent` works after the Session migration. Meant
to orient Claude sessions and writers of `docs/ai-chat/…` without
having to re-derive the design from the code.

Scope: everything in this document applies to the `ai-chat` PR
(`feature/tri-7532`, on top of `feature/tri-8627`). Neither is merged
yet. Once shipped, the old CHAT_STREAM_KEY / CHAT_MESSAGES_STREAM_ID /
CHAT_STOP_STREAM_ID constants are deleted and the three remaining
legacy consumers (MCP `agentChat` tool, `mock-chat-agent`,
dashboard `AgentView.tsx`) are migrated too.

## Why

Pre-migration, `chat.agent` ran entirely on run-scoped primitives:

- Output: one `streams.writer("chat")` on the current run.
- Input: two `streams.input()` definitions — `"chat-messages"` and
  `"chat-stop"`.
- The browser transport subscribed to
  `/realtime/v1/streams/{runId}/chat` and POST-ed to run-scoped
  input-stream URLs. `ChatSession` persistence was `{runId,
  publicAccessToken, lastEventId}`.

Every durable identity was the `runId`. That blocked:

- Resuming a chat across runs (run ends → session dies).
- Listing/filtering a user's chats (no `chatId → runId` inbox).
- Cross-tab and cross-device coordination beyond a single run.
- Moving chat state between tasks without smuggling it through run
  metadata.

Sessions give us a durable `{sessionId, externalId}` pair that
outlives any one run, plus a bidirectional typed channel pair
(`.in` / `.out`). The migration rebuilds `chat.agent`'s I/O on top
of Sessions with zero surface-level change to the public
`chat.agent()` / `TriggerChatTransport` / `AgentChat` APIs.

## The Session primitive (2-minute version)

Lives in `feature/tri-8627`. See `packages/core/src/v3/sessions.ts`
and `apps/webapp/app/routes/(api|realtime).v1.sessions*`.

- `sessions.create({type, externalId, …})` — Postgres upsert on
  `(environmentId, externalId)`. Idempotent.
- `sessions.open(id)` — returns a `SessionHandle { id, in, out }`.
  No network call until you hit a channel method.
- `.out` is a `SessionOutputChannel` — **producer-side API**:
  `append` (single record), `pipe(stream)`, `writer({execute})`
  (matches `streams.define`), plus `read(options?)` for external
  SSE consumers. All three producer methods route through
  `SessionStreamInstance` → `StreamsWriterV2` → direct-to-S2 so
  subscribers see a uniform parsed-object shape.
- `.in` is a `SessionInputChannel` — **consumer-side API for the
  task**: `on`, `once`, `peek`, `wait`, `waitWithIdleTimeout`
  (matches `streams.input`), plus `send(value)` for external
  producers. `.wait` / `.waitWithIdleTimeout` suspend the run
  through a **session-scoped waitpoint** — same mechanism as
  `streams.input.wait`, but the waitpoint fires when a record
  lands on the session's `.in` instead of a run's input stream.
- The two channels have **zero overlapping method names** —
  directional intent always stays at the call site.
- Session channels accept either the friendlyId (`session_*`) or
  the user-supplied externalId. The server disambiguates via the
  `session_` prefix.

## The chat mapping

One Session per chat conversation:

```
SessionHandle (durable identity, outlives runs)
├── .in   — chat messages + stops (tagged ChatInputChunk)
└── .out  — UIMessageChunks + control chunks

externalId  = chatId                  (client-owned, human-meaningful)
friendlyId  = session_xxxxxxxxxxxx    (generated, stable)
type        = "chat.agent"
```

A session's `.in` carries a discriminated union —
`ChatInputChunk` in `packages/trigger-sdk/src/v3/ai.ts`:

```ts
type ChatInputChunk<TMessage, TMetadata> =
  | { kind: "message"; payload: ChatTaskWirePayload<TMessage, TMetadata> }
  | { kind: "stop";    message?: string };
```

The task dispatches on `chunk.kind`. The message payload is the same
`ChatTaskWirePayload` the run originally received — so a
message-kind chunk at turn N mirrors the shape of turn 0's payload.

`.out` carries UIMessageChunks (token streaming) interleaved with
control chunks (`trigger:turn-complete`, `trigger:upgrade-required`)
and `chat.store` deltas. Semantically unchanged from pre-migration —
only the transport (S2 via Session) changed.

## End-to-end flow (first message)

```
 Browser                   Server action              Webapp / S2             Agent run
 ────────                   ─────────────              ──────────              ─────────
 useChat.sendMessage
   → transport.sendMessages
     → triggerTaskFn (if set)
                            sessions.create
                              externalId = chatId
                              type = "chat.agent"
                            → session_xxx
                            tasks.trigger(
                              "my-chat-agent",
                              { chatId, sessionId,
                                messages, trigger,
                                metadata })
                            auth.createPublicToken({
                              read:  { runs, sessions },
                              write: { inputStreams, sessions } })
                            → { runId, publicAccessToken,
                                sessionId }
     ← sessions.set(chatId, state)
     → subscribeToSessionStream
       GET /realtime/v1/sessions/{sessionId}/out
                                                      [SSE open]
                                                                               run starts
                                                                               payload.sessionId
                                                                               locals.set(chatSessionHandleKey,
                                                                                 sessions.open(sessionId))
                                                                               onChatStart()
                                                                               run() → streamText(…)
                                                                               pipeChat(uiStream)
                                                                                 → chatStream.pipe
                                                                                 → session.out.pipe
                                                                                 → SessionStreamInstance
                                                                                 → StreamsWriterV2
                                                                                 → S2
                                                      [records land on S2]
       ← SSE chunks stream                            [SSE delivers chunks]
           id: 0  start
           id: 1  start-step
           id: 2  text-start
           id: 3… text-delta
           …
                                                                               writeTurnCompleteChunk()
                                                                                 via chatStream.writer
           id: N  trigger:turn-complete                                         await messagesInput
                                                                                 .waitWithIdleTimeout(…)
                                                                               — run suspends on the
                                                                                 session-stream waitpoint
```

## Subsequent turns (run still live)

```
 Browser                                               Agent run (suspended)
 ────────                                              ─────────────────────
 transport.sendMessages (same chatId)
   state.runId is set → "existing run" branch
   → POST /realtime/v1/sessions/{sessionId}/in/append
     body: {"kind":"message","payload":{…}}
                                                      session append handler
                                                        drain waitpoints set
                                                      → complete waitpoint
                                                                               run resumes with
                                                                                 next message
                                                                               turn-complete chunk
                                                                               → session.out
                                                      [SSE delivers chunks]
   ← chunks …
```

## Subsequent turns (previous run ended)

Transport detects `state.runId` is gone (or append fails). Re-triggers a
new run on the same session — `sessionId` stays, only `runId` + PAT
refresh. Upgrade-required has the same shape.

## Stop

```
 Browser                                               Agent run (streaming)
 ────────                                              ─────────────────────
 transport.stopGeneration(chatId)
   → POST /realtime/v1/sessions/{sessionId}/in/append
     body: {"kind":"stop"}
                                                      session append handler
                                                      → complete waitpoint
                                                      → deliver to stopInput.on()
                                                                               currentStopController.abort()
                                                                               streamText aborts
                                                                               turn ends early,
                                                                               trigger:turn-complete
                                                                                 emitted on .out
                                                                               run returns to idle wait
```

`stopInput` is a module-level facade that filters `.in` for
`kind === "stop"`. The run's persistent listener fires on every stop
regardless of whether a turn is active.

## Module layout (SDK)

```
packages/trigger-sdk/src/v3/
├── ai.ts              chat.agent factory. Module-level facades:
│                      chatStream   : RealtimeDefinedStream<UIMessageChunk>
│                      messagesInput: RealtimeDefinedInputStream<ChatTaskWirePayload>
│                      stopInput    : RealtimeDefinedInputStream<{stop, message?}>
│                      Facades resolve `getChatSession()` at call time.
│                      chat.stream / chat.messages re-export them for users.
│                      Locals slot: chatSessionHandleKey.
│                      Initialized at run start from payload.sessionId
│                        (falls back to payload.chatId).
├── chat.ts            TriggerChatTransport. Calls:
│                        apiClient.createSession (ensureSession)
│                        apiClient.appendToSessionStream(..., "in", chunk)
│                        GET /realtime/v1/sessions/{sessionId}/out (SSE)
│                      ChatSessionState keys on sessionId, runId optional.
├── chat-client.ts     Server-side AgentChat + ChatStream.
│                      Same shape as TriggerChatTransport but uses the
│                      env secret key (apiClientManager.accessToken) so
│                      session CRUD doesn't need extra auth wiring.
├── sessions.ts        SessionHandle / SessionInputChannel /
│                      SessionOutputChannel. Thin SDK over the core
│                      ApiClient session methods + sessionStreams API.
```

## Module layout (core)

```
packages/core/src/v3/
├── schemas/api.ts                     Session CRUD + waitpoint schemas
├── apiClient/index.ts                 createSession / appendToSessionStream /
│                                      subscribeToSessionStream /
│                                      initializeSessionStream /
│                                      createSessionStreamWaitpoint
├── sessionStreams/
│   ├── types.ts                       SessionStreamManager interface
│   ├── noopManager.ts
│   ├── manager.ts                     StandardSessionStreamManager —
│   │                                  SSE tail + once/on/peek buffer
│   │                                  keyed on `{sessionId, io}`
│   └── index.ts                       SessionStreamsAPI facade
├── session-streams-api.ts             `sessionStreams` global singleton
└── realtimeStreams/
    └── sessionStreamInstance.ts       SessionStreamInstance — S2-only
                                       parallel of StreamInstance. Used
                                       by SessionOutputChannel.pipe/writer.
```

## Module layout (webapp)

```
apps/webapp/app/
├── routes/
│   ├── api.v1.sessions*.ts                    CRUD (create/list/retrieve/update/close)
│   ├── realtime.v1.sessions.$session.$io.ts   SSE subscribe + HEAD (last-seq)
│   ├── realtime.v1.sessions.$session.$io.append.ts
│   │                                          POST append — fires pending
│   │                                          session-stream waitpoints after
│   │                                          each record lands
│   └── api.v1.runs.$runFriendlyId.session-streams.wait.ts
│                                              POST create-waitpoint. Race-checks
│                                              the S2 stream at lastSeqNum so
│                                              pre-arrived data fires the
│                                              waitpoint synchronously.
├── services/
│   ├── realtime/
│   │   ├── sessions.server.ts                 resolveSessionByIdOrExternalId,
│   │   │                                      serializeSession
│   │   └── s2realtimeStreams.server.ts        appendPartToSessionStream,
│   │                                          readSessionStreamRecords,
│   │                                          streamResponseFromSessionStream
│   ├── sessionStreamWaitpointCache.server.ts  Redis set keyed on
│   │                                          `ssw:{sessionFriendlyId}:{io}`;
│   │                                          drained atomically on append
│   └── sessionsReplicationService.server.ts   Postgres → ClickHouse sessions_v1
```

## Token scopes

The PAT minted for the browser transport carries **both** run and
session scopes — so a single token covers every session-side call the
transport makes (append, subscribe) plus any remaining run-scoped
fallbacks:

```
{
  read:  { runs: runId, sessions: sessionId },
  write: { inputStreams: runId, sessions: sessionId },
}
```

Three mint sites in `ai.ts`:

- `createChatTriggerAction` (server-side `triggerTask` helper —
  creates the session before triggering, returns `sessionId` in the
  result).
- `preloadAccessToken` (agent-side, per-preload).
- `turnAccessToken` (agent-side, refreshed each turn, delivered via
  the `trigger:turn-complete` chunk's `publicAccessToken` field).

The server-side `AgentChat` / `ChatStream` path uses the environment
secret key directly — no per-run tokens needed.

## Key invariants

- **Sessions outlive runs.** Session close is client-driven; the
  task runtime never auto-closes.
- **`.in` and `.out` are disjoint.** No method appears on both
  channels; directional intent is always at the call site.
- **Uniform serialization on `.out`.** `append`, `pipe`, `writer` all
  route through `StreamsWriterV2` so subscribers always receive
  parsed objects, never raw JSON strings.
- **Suspend-while-idle on `.in`.** Session-stream waitpoints use the
  same run-engine mechanism as input-stream waitpoints — no compute
  is consumed between turns.
- **One run per active turn.** The transport's first-message path
  triggers a run; subsequent messages land via `.in.send(...)`
  against the same run (or spawn a new run on the same session if
  the previous one ended).

## Public API surface (what changed / what's the same)

Unchanged:

- `chat.agent({ id, run, onChatStart, … })`
- `chat.stream`, `chat.messages`, `chat.createStopSignal`
- `chat.store.set / patch / get / onChange`
- `chat.response.write`, `chat.defer`, `chat.history`, etc.
- `TriggerChatTransport` options and methods
- `AgentChat` server-side API

Grown:

- `ChatTaskWirePayload` / `ChatTaskPayload` / `ChatTaskRunPayload`
  gain optional `sessionId`.
- `TriggerChatTaskResult` gains optional `sessionId`.
- `TriggerChatTransport.getSession` / `setSession` / `onSessionChange`
  / `sessions` options all carry `sessionId`; `runId` is now optional.
- `AgentChat.ChatSession` persistence type gains `sessionId`.

Added (public):

- `sessions.create / retrieve / update / close / list / open`
- `SessionHandle`, `SessionInputChannel`, `SessionOutputChannel`

## Known follow-ups

Tracked on task #49 in the project task list:

- Migrate three remaining legacy-stream consumers (still use
  run-scoped stream URLs):
  - `packages/cli-v3/src/mcp/tools/agentChat.ts` — MCP chat tool
    Claude uses to talk to agents.
  - `packages/trigger-sdk/src/v3/test/mock-chat-agent.ts` — the
    offline test harness. Needs a `TestSessionStreamManager` plus
    a pipe/writer sink in `mock-task-context.ts` since the agent
    now writes through `SessionStreamInstance` (direct-to-S2) which
    the current output-inspection driver doesn't intercept.
  - `apps/webapp/app/components/runs/v3/agent/AgentView.tsx` — the
    dashboard's per-run agent viewer. Still subscribes to
    `/realtime/v1/streams/{runId}/chat`.
- Delete `CHAT_STREAM_KEY` / `CHAT_MESSAGES_STREAM_ID` /
  `CHAT_STOP_STREAM_ID` from `packages/core/src/v3/chat-client.ts` +
  `packages/trigger-sdk/src/v3/chat-constants.ts` + re-exports in
  `ai.ts` once those three consumers are migrated.
- Full UI smoke in `references/ai-chat` (send / stop / refresh-resume
  / multi-turn / cross-run resume). Core end-to-end flow already
  validated via `chat-agent-smoke` in `references/hello-world`.

## Smoke tests

- `sessions-smoke` (`references/hello-world/src/trigger/sessionsSmoke.ts`)
  — control plane + `.out.writer` + `.out.append` + `.in.send` +
  list / pagination / close / idempotent close.
- `sessions-wait-smoke` (`references/hello-world/src/trigger/sessionsWaitSmoke.ts`)
  — full waitpoint suspend/resume path. Orchestrator suspends on
  `.in.waitWithIdleTimeout`; delayed sender fires the waitpoint via
  `.in.send`; orchestrator resumes with the payload.
- `chat-agent-smoke` (`references/hello-world/src/trigger/chatAgentSmoke.ts`)
  — end-to-end chat.agent flow. Creates a session, triggers
  `test-agent` with `{chatId, sessionId, messages, …}`, subscribes to
  `session.out`, asserts 14 UIMessageChunks (`start` /
  `start-step` / `text-start` / 7× `text-delta` / `text-end` /
  `finish-step` / `finish` / `trigger:turn-complete`) with ids 0–13.
  Requires `OPENAI_API_KEY` in the dev env.

## Git trail

Sessions branch (`feature/tri-8627-session-primitive-server-side-schema-routes-clickhouse`):

```
4cadc19 feat(webapp,core): Session channel waitpoints — server side
95f3c00 fix(webapp): tighten sessions create + list auth
829ccc4 fix(webapp): allow JWT + CORS on sessions list endpoint
27fb4a4 fix(core): reject externalId starting with 'session_' on Session create/update
6f9dbe5 code review fixes
16ee28f feat(webapp,clickhouse,database,core): Session primitive (server side)
```

AI-chat branch (`feature/tri-7532-ai-sdk-chat-transport-and-chat-task-system`):

```
7aa6687 fix(sdk,chat): route pipeChat through session.out + chat-agent smoke test
762ed92 feat(sdk): server-side ChatStream / AgentChat → Sessions (phase D)
91b0481 feat(sdk): chat.agent → Sessions migration (phases B + C + min E)
e72555b feat(sdk,core): Session channel SDK toolkits + waitpoints — client side
0191302 feat(sdk,core): Session client SDK + hello-world smoke test
```

Later commits on the chat branch (chat.store, hydrateMessages,
multi-tab coordination, tool approvals, etc.) pre-date the Session
migration and are unchanged by it — the migration changed plumbing,
not public surface.
