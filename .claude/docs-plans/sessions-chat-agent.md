# Docs plan — Sessions primitive + chat.agent migration

Plan for updating Mintlify docs to cover:

1. **Sessions** — net-new public primitive (`sessions.create/open/list/close`, `SessionHandle`, `.in`/`.out`) that doesn't exist in docs yet.
2. **chat.agent on Sessions** — 14 ai-chat pages reference the old run-scoped wire protocol. Public `chat.agent()` surface is unchanged, but the underlying transport, persistence shape, and wire endpoints all moved.
3. **Session-settled signal** — recent improvement (`X-Session-Settled` response header, `wait=0` drain on settled reconnects). Needs mention on frontend/server-chat pages.

Architecture reference (what the system actually does, for doc writers):
`.claude/architecture/chat-agent-sessions.md`.

## Relationship to other doc plans

Coordinate with the hydration/history/actions plan saved in
`project_docs_update_plan.md` (memory). Sessions should land **first** —
it's the foundational primitive the other features reference.

---

## Phase 1 — Sessions primitive docs (net-new)

New top-level section `docs/sessions/`, added as a dropdown group in
`docs.json`. Should ship as its own PR and merge before Phase 2 so
chat.agent docs can link into it.

| File | Covers |
|---|---|
| `sessions/overview.mdx` | What a Session is. Identity (`sessionId` + `externalId`, `session_*` friendly format, externalId idempotency on create). `.in` / `.out` channels as a durable typed I/O pair. Durability across runs. When to use Sessions vs. run-scoped streams. That `chat.agent` is built on Sessions. |
| `sessions/quick-start.mdx` | Minimal end-to-end: `sessions.create` → `sessions.open` → `.out.append` + `.in.on` → `sessions.close`. Model on `ai-chat/quick-start.mdx` shape. |
| `sessions/channels.mdx` | Deep dive. `.out` producer API (`append`, `pipe`, `writer({execute})` matching `streams.define`) and external consumer API (`read`). `.in` consumer API (`on`, `once`, `peek`, `wait`, `waitWithIdleTimeout` matching `streams.input`) and external producer API (`send`). Suspend-while-idle via session-stream waitpoints. Uniform serialization on `.out` (subscribers always get parsed objects). |
| `sessions/reference.mdx` | API reference. `sessions.create / retrieve / update / close / list / open`. `SessionHandle`, `SessionInputChannel`, `SessionOutputChannel`. Token scopes: `read:sessions`, `write:sessions`, `admin:sessions`, super-scopes. |
| `sessions/patterns.mdx` *(optional — can defer)* | Cross-run resume. Inbox via `sessions.list({type, tags})`. Multi-agent shared channels (two agents coordinating on one session). Custom transports keyed on `externalId`. |

Navigation: add `Sessions` dropdown to `docs.json`, placed adjacent to
`AI Chat` so readers see the relationship.

---

## Phase 2 — Update chat.agent docs

Ships after Phase 1 merges. One PR.

| File | Change |
|---|---|
| `ai-chat/client-protocol.mdx` | **Full rewrite.** Old run-scoped endpoints (`POST /api/v1/tasks/:id/trigger`, `GET /realtime/v1/streams/:runId/chat`, `POST /realtime/v1/streams/:runId/input/chat-messages`) are gone. New surface: `POST /api/v1/sessions` (create, idempotent on externalId), `POST /realtime/v1/sessions/:session/:io/append` (input chunks — note `io="in"` for chat), `GET /realtime/v1/sessions/:session/:io` (SSE subscribe, `io="out"`). Document `ChatInputChunk` tagged union (`{kind: "message", payload}` / `{kind: "stop", message?}`). Document `Last-Event-ID` resume. Document `X-Session-Settled: true` response header and when it fires (server peeks `.out` tail; if last record is `trigger:turn-complete`, SSE uses `wait=0` and closes fast with this header). |
| `ai-chat/frontend.mdx` | Update `TriggerChatTransport`. Persistence shape grew: `{sessionId, publicAccessToken, lastEventId, runId?, isStreaming?}` — `sessionId` is the durable identity now, `runId` is a live-run hint. `isStreaming` is **optional** after the settled-signal work; callers that drop it get server-decided settled behavior with no 60s hang. `onSessionChange` now carries `sessionId`. Note: cross-run resume is free — same chat persists across page reloads, across day boundaries, across process exits. |
| `ai-chat/server-chat.mdx` | Same persistence shape update for `AgentChat`. `ChatSession` type gained `sessionId`. Same cross-run resume story. |
| `ai-chat/backend.mdx` | `ChatTaskWirePayload` / `ChatTaskPayload` / `ChatTaskRunPayload` grew optional `sessionId`. Agent code rarely needs to touch it — `chat.stream`, `chat.messages`, `chat.stopSignal` still work identically. Show `sessions.open(payload.sessionId)` as an escape hatch for advanced cases (e.g., writing to the session from a sub-agent or from outside the turn loop). |
| `ai-chat/reference.mdx` | Add `ChatInputChunk<TMessage, TMetadata>` type. Update `ChatSession` shape. Document `TriggerChatTaskResult.sessionId`. Session scopes list. Link to `sessions/reference`. |
| `ai-chat/overview.mdx` | Conceptual: chats now outlive individual runs. Inbox pattern via `sessions.list({type: "chat.agent"})`. Link to `/sessions/overview`. |
| `ai-chat/quick-start.mdx` | Minimal edit. One sentence: sessions power the chat primitive; link out to `/sessions/overview` for the underlying model. |
| `ai-chat/changelog.mdx` | New entry covering (a) the session migration, (b) the settled-signal improvement (optional `isStreaming`). |
| `ai-chat/testing.mdx` | `mockChatAgent` now drives `.in` via `drivers.sessions.in.send(sessionId, {kind, payload})` instead of the old input-stream manager. `TestSessionStreamManager` + `TestSessionOutputChannel` replace the stream-based harness. Update any code examples. |
| `ai-chat/patterns/version-upgrades.mdx` | `trigger:upgrade-required` flow now reuses `sessionId` across runs — a single line clarifying that only `runId` + PAT refresh, `sessionId` stays. |
| `ai-chat/patterns/human-in-the-loop.mdx` | Audit for stale stream-ID references; likely only a small update if any. |

---

## Phase 3 — Cross-references in realtime docs

Tacked onto the Phase 2 PR. Trivial edits.

| File | Change |
|---|---|
| `realtime/backend/streams.mdx` | Callout: "For durable, long-lived channels that outlive a single run (e.g. chat agents), see [Sessions](/sessions/overview)." Run-scoped streams are not deprecated — they're still correct for ephemeral run I/O. |
| `realtime/backend/input-streams.mdx` | Same callout. |

---

## Out of scope

- **Deprecation of run-scoped streams.** They remain the right primitive for ephemeral per-run I/O. Sessions is additive, not a replacement.
- **Rewriting pattern pages that happen to work unchanged.** `code-sandbox`, `skills`, `sub-agents`, `branching-conversations`, `database-persistence`, `compaction`, `pending-messages`, `background-injection`, `error-handling`, `mcp` — only touch if there's a concrete stale reference. Audit quickly; don't rewrite prophylactically.
- **Wire-protocol examples for non-chat session uses.** If `sessions/patterns.mdx` gets written, covers this lightly. Otherwise defer — Sessions is general-purpose but chat is the primary motivating use case for v1 docs.
- **Migration guide for external callers of the old wire protocol.** The `chat-constants.ts` commit already documented the mapping in its commit message (`streams.writer(CHAT_STREAM_KEY)` → `sessions.open(sessionId).out.writer(...)`, etc.). If we hear from users building custom non-`TriggerChatTransport` clients, we can write a dedicated migration page then.

---

## Sizing

Rough effort estimates, in full dedicated doc passes:

- Phase 1 — ~1 pass. 4 net-new pages, `sessions/overview` and `sessions/channels` are the meaty ones; `sessions/patterns` is optional and can be Phase 1.5.
- Phase 2 — ~1 pass. `client-protocol.mdx` is the single biggest rewrite (~half a pass); the other 10 edits are paragraph-level.
- Phase 3 — rounds to zero; fold into Phase 2 PR.

Total: ~2 dedicated doc passes, ideally across two PRs.

---

## Sequencing decision

Phase 1 **before** Phase 2. Two reasons:

1. Phase 2 pages will link into `/sessions/*`; merging Phase 2 first creates broken links in published docs.
2. Readers encountering `sessionId` in updated chat docs need somewhere to go to learn what a Session is. That page has to exist first.

Phase 1.5 (the optional `sessions/patterns.mdx` page) can ship either with Phase 1 or as a follow-up — it's not on the critical path for Phase 2.
