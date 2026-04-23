# Docs update plan: Sessions-as-run-manager

Companion to commits `7a48c1e6` (ai-chat) and `427541c2` (sessions server). Captures every doc page that needs to change, what's getting removed, and an upgrade guide for prerelease users.

## Architectural summary (the diff readers should internalize)

Pre-migration mental model: Sessions and chat.agent were two separate primitives. Sessions had its own create/list/close API; chat.agent rolled its own run-scoped streams. The two coexisted but didn't share machinery — chat.agent's wire path (run streams) was distinct from Sessions' wire path (`.in` / `.out` channels).

Post-migration mental model: **Sessions is the run manager.** A Session row is task-bound (`taskIdentifier` + `triggerConfig` are required), it owns its current run via `currentRunId` (optimistic-claim), and it tracks every run it ever triggered in a `SessionRun` audit table. chat.agent is now just a particular kind of task you bind a Session to. The standalone "create a Session, then trigger something against it" path is gone — `sessions.start({...})` atomically creates the row and triggers the first run.

Wire-level, the transport now talks to one set of routes (`/realtime/v1/sessions/:s/...` and `/api/v1/sessions/:s/...`); the per-run-stream code path is dead for chat.

## Standalone Sessions docs: REMOVE

`docs/sessions/` was written for the standalone-Session model. With sessions now task-bound, every page in that directory is incorrect:

- `sessions/overview.mdx` — describes a generic session-as-bidirectional-channel primitive. Standalone create/list/close as the entry point.
- `sessions/quick-start.mdx` — `sessions.create({type, externalId})` then trigger something. Pattern no longer exists.
- `sessions/channels.mdx` — `.in` / `.out` documented from the standalone-session perspective.
- `sessions/reference.mdx` — API surface for the standalone primitive.

**Action:**
1. Delete all four files: `docs/sessions/{overview,quick-start,channels,reference}.mdx`.
2. Remove the entire `Sessions` group from `docs/docs.json` under the `AI` group:
   ```json
   {
     "group": "Sessions",
     "pages": ["sessions/overview", "sessions/quick-start", "sessions/channels", "sessions/reference"]
   }
   ```
3. Don't redirect — the URLs were never widely shared (this was alpha-tier surface). If we add Sessions docs back later, we can decide redirect-vs-fresh-slug then.

We'll re-introduce Sessions docs once the primitive is stable and we have a non-chat.agent customer flow to document.

## ai-chat docs: UPDATE

Pages listed in the order they appear in `docs.json`. Each entry calls out the specific stale claims and what to replace.

### `ai-chat/overview.mdx`
- Replace any line that says chat.agent runs on per-run streams or that the transport mints run-scoped tokens.
- Add one paragraph on the underlying primitive: chat.agent is bound to a Session that owns its runs. Customer-facing surface unchanged.
- If there's a "how it works" diagram, update arrows: browser → server action → `chat.createStartSessionAction` → Session row + first run + session PAT → browser → `.in/append` + `.out` SSE.

### `ai-chat/changelog.mdx`
- Add an entry for the migration: "Sessions-as-run-manager — chat.agent now runs on top of a durable Session row that owns its runs. Public surface unchanged. See upgrade guide."

### `ai-chat/quick-start.mdx`
- The transport snippet is the highest-value example in the docs. It must show the new shape:
  ```ts
  const transport = useTriggerChatTransport<typeof myAgent>({
    task: "my-agent",
    accessToken: ({ chatId }) => mintAccessToken(chatId),
    startSession: ({ chatId, taskId, clientData }) =>
      startChatSession({ chatId, taskId, clientData }),
  });
  ```
- Server actions page should show `chat.createStartSessionAction("my-agent")` and `auth.createPublicToken({scopes: {sessions: chatId}})`.
- Drop any mention of `getStartToken` and `auth.createTriggerPublicToken` for the chat path.

### `ai-chat/backend.mdx`
- The `chat.agent({...})` shape itself is unchanged — leave the `run`, `onPreload`, `onTurnStart`, `onTurnComplete` callbacks alone.
- Add a section on `chat.createStartSessionAction(taskId, options?)`. This is the canonical server-side entry point now. Show:
  - Default `triggerConfig.basePayload`: `{messages: [], trigger: "preload"}` baked in. Customer overrides via `options.triggerConfig`.
  - Idempotent on `(env, externalId)`. Concurrent calls for the same chatId converge.
  - Returns `{sessionId, runId, publicAccessToken}`.
- Update `chat.requestUpgrade()` description: it now calls `endAndContinueSession` server-side, which atomically swaps `Session.currentRunId` to a new run. Browser keeps streaming across the swap.

### `ai-chat/frontend.mdx`
- This is where most of the transport API lives. Rewrite around the two callbacks:
  - `accessToken: ({chatId}) => string` — pure refresh, called on 401/403.
  - `startSession?: ({chatId, taskId, clientData}) => {publicAccessToken}` — wraps the customer's server action, called on `transport.preload(chatId)` and lazy first `sendMessage`.
- Show the typed `clientData` flow: `useTriggerChatTransport<typeof myAgent>` infers `clientData` from `withClientData`, threads it into `startSession`'s params, and merges into per-turn `metadata`.
- Drop `getStartToken` documentation entirely.
- `transport.preload(chatId)` no longer takes per-call options. If the customer needs dynamic per-call config they capture it in their server action via closure (typically over a ref for live values like the playground's `clientDataJsonRef`).
- Persistable `ChatSession`: `{publicAccessToken, lastEventId?}`. `runId` is gone.

### `ai-chat/server-chat.mdx`
- `AgentChat` (server-side chat client) — same shape, but the `session` prop now takes `{lastEventId?}` only.
- `onTriggered({runId, chatId})` callback is still useful for telemetry / dashboard linking — the `runId` is the *current* run, not the only run. Note that across turns the runId may change (continuation runs after idle, upgrade runs, etc.).

### `ai-chat/types.mdx`
- `ChatSession` — drop `runId`, drop `sessionId`. Just `{publicAccessToken, lastEventId?}`.
- `StartSessionParams<TClientData>`, `StartSessionResult` — new public types.
- `AccessTokenParams` — narrowed to `{chatId}` only (no metadata threading).
- Remove `GetStartTokenParams` from the type table.

### `ai-chat/features.mdx`
- Audit for any mention of run-scoped streams, `CHAT_STREAM_KEY`, `CHAT_MESSAGES_STREAM_ID`, `CHAT_STOP_STREAM_ID`. All gone.
- Add: cross-form addressing on the wire (a session-scoped JWT minted for either `externalId` or `friendlyId` form authorizes either URL form).
- Add: SessionRun audit log — every run a chat session has triggered is recorded, queryable via the dashboard.

### `ai-chat/compaction.mdx`
- Should be untouched (compaction lives inside `chat.agent`'s turn loop, doesn't depend on the wire model).

### `ai-chat/pending-messages.mdx`
- Should be untouched (steering messages flow through `.in.append` regardless).

### `ai-chat/background-injection.mdx`
- Same — injection happens inside the run, the run's wire path swap doesn't affect it.

### `ai-chat/error-handling.mdx`
- Add: errors from `startSession` callback. The customer's server action can fail (auth check, DB write). Surface via `onSessionChange(chatId, null)` or via the customer's own try/catch in their callback.
- Replace any 401/403 retry logic that mentions `getStartToken` — it's `accessToken` now.

### `ai-chat/mcp.mdx`
- Audit for `getStartToken` mentions in MCP tool examples.

### `ai-chat/testing.mdx`
- The `mock-chat-agent` test harness moved to `setupSessionStartImplForTests` / similar — verify and update examples.
- Show how to mock `startSession` in unit tests (it's a fetch-mock or vi.fn returning `{publicAccessToken}`).

### `ai-chat/client-protocol.mdx`
- The wire-level protocol page. Replace any `/realtime/v1/streams/{runId}/chat` URLs with `/realtime/v1/sessions/{chatId}/{io}`.
- Document the chunk shape on `.in`: tagged union — `{kind: "message", payload}` for user turns, `{kind: "stop"}` for stop signals, `{kind: "action", name, payload}` for typed actions.
- Document `.out` chunks: `UIMessageChunk`s interleaved with `trigger:turn-complete`, `trigger:upgrade-required` control markers.
- Cross-form addressing on session-scoped PATs.

### `ai-chat/reference.mdx`
- Public API surface tables. `TriggerChatTransportOptions` — drop `getStartToken`, `triggerConfig`, `triggerOptions`; add `startSession`.
- `chat.createStartSessionAction(taskId, options?)` — full signature.
- `chat.requestUpgrade()` — keep, but note the new server-orchestrated swap behaviour.

### `ai-chat/patterns/version-upgrades.mdx`
- This page is essentially about `chat.requestUpgrade()`. Update to explain the new mechanism:
  - Old: agent emitted `trigger:upgrade-required` chunk, transport consumed it, transport triggered a new run from the browser side.
  - New: agent calls `endAndContinueSession` (server-to-server), webapp atomically swaps `Session.currentRunId` to a freshly-triggered run, transport's existing SSE keeps streaming on the same session — no transport-side swap.
- Add: `SessionRun` audit row with `reason: "upgrade"`.

### `ai-chat/patterns/sub-agents.mdx`
- Audit for any session.create / sub-agent-as-session-creator patterns. Sub-agents now get their session via the parent's task trigger (or by calling `sessions.start({ ... })` themselves with a different taskIdentifier).

### `ai-chat/patterns/database-persistence.mdx`
- The reference app's `ChatSession` schema is now simpler: `{id, publicAccessToken, lastEventId?}`. Drop `runId`/`sessionId` columns from any example schemas.
- The persistence pattern itself is unchanged: persist the PAT + lastEventId, hydrate on page load via `sessions: { [chatId]: ... }` on the transport.

### `ai-chat/patterns/branching-conversations.mdx`
- Should be mostly unchanged. Branching is a customer-side concern (multiple chatIds, each one its own session).

### `ai-chat/patterns/code-sandbox.mdx`
- Audit for stale references. Probably fine.

### `ai-chat/patterns/human-in-the-loop.mdx`
- Should be unchanged.

### `ai-chat/patterns/skills.mdx`
- Should be unchanged.

## NEW page: upgrade guide for chat.agent prerelease users

Filename: `docs/ai-chat/upgrade-guide.mdx` (or `migration-from-prerelease.mdx` — pick whichever fits the docs style). Add to `docs.json` near the top of the AI Chat group, between `overview` and `quick-start`.

Contents:

```mdx
---
title: "Upgrade guide: prerelease → Sessions-as-run-manager"
description: "Migrating chat.agent code from the prerelease API to the Sessions-as-run-manager release."
---

# Upgrade guide

This guide is for customers who tried `chat.agent` during the prerelease period
(any `@trigger.dev/sdk` build before vX.Y.Z). The public surface is largely
unchanged — `chat.agent({...})`, `useTriggerChatTransport`, `chat.store` /
`chat.defer` / `chat.history`, `AgentChat` — but the transport callbacks and a
few server-side helpers were renamed.

## TL;DR

- **`getStartToken` is gone.** Replace with `startSession`, a server-action
  callback that returns `{publicAccessToken}`.
- **`chat.createStartSessionAction(taskId, options?)` is the canonical
  server-side entry point.** Replaces ad-hoc `auth.createTriggerPublicToken` +
  manual session create.
- **`ChatSession` persistable shape changed.** Drop the `runId` field;
  store only `{publicAccessToken, lastEventId?}`.
- **`transport.preload(chatId)` no longer takes per-call options.**
  Trigger config (machine, idleTimeoutInSeconds, tags) lives server-side in
  `chat.createStartSessionAction(taskId, options)`.
- **Wire URLs changed.** Anything that hit
  `/realtime/v1/streams/{runId}/chat` directly should use
  `/realtime/v1/sessions/{chatId}/out` (subscribe) or
  `/realtime/v1/sessions/{chatId}/in/append` (send).

## Transport: replace `getStartToken` with `startSession`

### Before

```ts
const transport = useTriggerChatTransport({
  task: "my-agent",
  accessToken: async ({ chatId }) => mintToken(chatId),
  getStartToken: async ({ taskId }) => mintTriggerToken(taskId),
  triggerConfig: { basePayload: { /* ... */ } },
  triggerOptions: { tags: [...], machine: "small-1x" },
});
```

The browser called `auth.createTriggerPublicToken(taskId)` server-side to get
a one-shot trigger JWT, then `POST /api/v1/sessions` from the browser.

### After

```ts
const transport = useTriggerChatTransport<typeof myAgent>({
  task: "my-agent",
  accessToken: ({ chatId }) => mintAccessToken(chatId),
  startSession: ({ chatId, taskId, clientData }) =>
    startChatSession({ chatId, taskId, clientData }),
});
```

Where `startChatSession` is a server action wrapping
`chat.createStartSessionAction`:

```ts
"use server";
import { chat } from "@trigger.dev/sdk/ai";

export const startChatSession = chat.createStartSessionAction("my-agent", {
  triggerConfig: {
    machine: "small-1x",
    tags: ["my-tag"],
  },
});
```

The browser never holds a `trigger:tasks:{taskId}` JWT now. All session
creation goes through the customer's server, where authorization decisions
live alongside the customer's own DB writes.

## Server actions: replace ad-hoc helpers with `chat.createStartSessionAction`

### Before

```ts
"use server";
import { auth, sessions } from "@trigger.dev/sdk";

export async function startChatSession({ chatId, taskId }) {
  const session = await sessions.create({
    type: "chat.agent",
    externalId: chatId,
  });
  // ... separately trigger the agent task ...
  const publicAccessToken = await auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
  });
  return { publicAccessToken };
}
```

### After

```ts
"use server";
import { chat } from "@trigger.dev/sdk/ai";

export const startChatSession = chat.createStartSessionAction("my-agent");
```

The new helper handles session creation + first-run trigger + PAT mint
atomically. It's idempotent on `(env, externalId)` — concurrent calls for the
same `chatId` converge to the same session.

## `ChatSession` shape: drop `runId`

Persistable session state is now just the PAT + last event ID:

```ts
// before
type ChatSession = { runId: string; publicAccessToken: string; lastEventId?: string };

// after
type ChatSession = { publicAccessToken: string; lastEventId?: string };
```

If your DB schema has a `runId` column on a session-state table, drop it (or
keep it for telemetry — but the transport doesn't read it). The current run
ID is server-side state on the Session row; the transport doesn't need to
know it.

## `clientData`: typed and threaded automatically

If your agent uses `chat.agent(...).withClientData({schema})`, the transport
infers the `clientData` type from `useTriggerChatTransport<typeof agent>`
and threads it through `startSession`'s params. Set it once on the
transport:

```ts
useTriggerChatTransport<typeof myAgent>({
  // ...
  clientData: { userId: currentUser.id, plan: currentUser.plan },
});
```

The same value also merges into per-turn `metadata` on the wire, and your
`startSession` callback receives it as `params.clientData`. Pass through to
`chat.createStartSessionAction` via `triggerConfig.basePayload.metadata` and
the agent's first run sees it in `payload.metadata`.

## `chat.requestUpgrade()`: server-orchestrated now

The behaviour didn't change from the customer's perspective — call
`chat.requestUpgrade()` inside `onTurnStart` / `onValidateMessages` and the
current run will exit so the next message starts on the latest version.

What changed under the hood:

- **Before:** the agent emitted a `trigger:upgrade-required` chunk on
  `.out`, the transport consumed it browser-side and triggered a new run.
- **After:** the agent calls `endAndContinueSession` server-to-server, the
  webapp triggers a new run and atomically swaps `Session.currentRunId`,
  the browser's existing SSE subscription keeps receiving chunks across
  the swap. Faster handoff, no browser-side bookkeeping.

The `SessionRun` audit table records every run, including upgrade-driven
ones (with `reason: "upgrade"`).

## Going to URLs directly?

Anyone hitting raw URLs (instead of going through the SDK) should switch:

| Before | After |
|---|---|
| `/realtime/v1/streams/{runId}/chat` (subscribe) | `/realtime/v1/sessions/{chatId}/out` |
| `/realtime/v1/streams/{runId}/{target}/chat-messages/append` | `/realtime/v1/sessions/{chatId}/in/append` (`{kind: "message", payload}` body) |
| `/realtime/v1/streams/{runId}/{target}/chat-stop/append` | `/realtime/v1/sessions/{chatId}/in/append` (`{kind: "stop"}` body) |

The session-scoped PAT (`read:sessions:{chatId} + write:sessions:{chatId}`)
authorizes both the `externalId` form (e.g. `/sessions/my-chat-id/out`)
and the `friendlyId` form (e.g. `/sessions/session_abc.../out`).

## Things that didn't change

- `chat.agent({...})` definition shape and all callbacks.
- `chat.store` / `chat.defer` / `chat.history` APIs.
- `AgentChat` (server-side chat client) — same constructor, same methods.
- `useTriggerChatTransport`'s React semantics (created once, kept in a ref,
  callbacks updated via `setOnSessionChange` / `setClientData` under the hood).
- Multi-tab coordination, pending-messages / steering, background injection.
- Per-turn `metadata` flowing through `sendMessage({ text }, { metadata })`.
```

## Other doc surfaces touched

- `docs/ai/prompts.mdx` — only mentions `chat.agent` in passing. Audit but probably no change.
- `docs/realtime/backend/streams.mdx`, `docs/realtime/backend/input-streams.mdx` — these are the older streams API docs. Verify they don't reference `CHAT_STREAM_KEY` or `CHAT_MESSAGES_STREAM_ID` (those constants were removed).
- `docs/mcp-tools.mdx` — likely mentions the chat MCP tools. Audit for `getStartToken`-shaped examples.
- `docs/guides/example-projects/anchor-browser-web-scraper.mdx` — example project. Likely uses `chat.agent`. Audit.
- `docs/tasks/schemaTask.mdx` — only matched on the term "session" probably. Audit.

## Update sequence

Suggested order to minimise stale-state windows for readers:

1. **Add the upgrade guide** (`ai-chat/upgrade-guide.mdx`) and its nav entry. This is the most-needed doc and stands alone from the rest.
2. **Update transport-shape pages** in this order: `quick-start` → `frontend` → `backend` → `server-chat` → `types` → `reference`. They all show the same callback shape; readers cross-reference between them, so they should ship together.
3. **Update peripheral pages**: `overview`, `changelog`, `client-protocol`, `error-handling`, `testing`, `features`, patterns.
4. **Remove `docs/sessions/`** + nav group last. Until step 2 lands the standalone Sessions docs are still less misleading than half-stale chat.agent docs.

## Out of scope for this pass

- Re-adding standalone Sessions docs (deferred until the primitive is stable for non-chat use).
- Diagrams / illustrations — text-first pass; designer can layer visuals after.
- Sample customer projects — the `references/ai-chat` reference repo is the in-source example; if marketing wants a polished standalone sample, that's a separate effort.
