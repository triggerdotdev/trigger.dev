# Review guide — chat.agent on Sessions, row-agnostic addressing

Scope: the 12 uncommitted files. **No new behaviour beyond the public surface
already on this branch** — this is plumbing cleanup that:

1. Eliminates the transport's session-creation step
2. Makes `chatId` the universal addressing string everywhere
3. Makes the server-side stream/append/wait routes row-agnostic

## The two design moves

**Move 1 — agent owns session lifecycle.** `chat.agent` and
`chat.customAgent` upsert the backing `Session` row at bind, fire-and-forget,
keyed on `externalId = payload.chatId`. The transport, server-side
`AgentChat`, and `chat.createTriggerAction` no longer create sessions at all.
Browsers cannot mint sessions either (`POST /api/v1/sessions` is now
secret-key-only). One owner, one path.

**Move 2 — `chatId` is the only address.** The transport, server-side
`AgentChat`, JWT scopes, and S2 stream paths all use `chatId` directly. The
Session's friendlyId is informational. To make this safe, the three stream
routes (`.in/.out` PUT, GET, POST append, plus the run-engine `wait`
endpoint) became "row-optional" and derive a *canonical addressing key*
(`row.externalId ?? row.friendlyId`, fallback to the URL param when the row
hasn't been upserted yet). Same canonical key is used to build the S2 stream
path, the waitpoint cache key, and the JWT resource set — so any caller
addressing by either form converges on the same physical stream.

Together these remove an entire class of "did the row land yet?" races. The
transport can subscribe to `/sessions/{chatId}/out` before the agent boots,
the agent's `void sessions.create({externalId: chatId})` lands a moment
later, and any earlier reads/writes are already on the right S2 key.

---

## Read in this order

### 1. `apps/webapp/app/services/realtime/sessions.server.ts` (+34 lines)

The new primitive. Two helpers:

- `isSessionFriendlyIdForm(value)` — `value.startsWith("session_")`. Used to
  decide whether a missing row is a hard 404 (opaque friendlyId) or a soft
  "row will land later" (externalId form).
- `canonicalSessionAddressingKey(row, paramSession)` — `row.externalId ??
  row.friendlyId` if the row exists, else `paramSession`. **This is the load-
  bearing function.** Read its docstring.

**Question to ask:** can two callers addressing the "same" session ever get
different canonical keys? Only if the row exists for one and not the other,
*and* the URL forms differ — but in that case the row-less caller used the
externalId form (friendlyId-form would have 404'd earlier), and the row-ful
caller computes `row.externalId ?? row.friendlyId`. If the row's externalId
matches the URL, they converge. If it doesn't, there's no row to find by
that string anyway. The interesting edge is "row exists with no externalId",
addressed via friendlyId — both sides read `row.friendlyId`. ✓

### 2. `apps/webapp/app/routes/realtime.v1.sessions.$session.$io.ts` (+47/-12)

PUT initialize + GET subscribe (SSE). Both use the helper. The interesting
part is the loader's `findResource` + `authorization.resource`:

```ts
findResource: async (params, auth) => {
  const row = await resolveSessionByIdOrExternalId(...);
  if (!row && isSessionFriendlyIdForm(params.session)) return undefined; // 404
  return { row, addressingKey: canonicalSessionAddressingKey(row, params.session) };
},
authorization: {
  resource: ({ row, addressingKey }) => {
    const ids = new Set<string>([addressingKey]);
    if (row) {
      ids.add(row.friendlyId);
      if (row.externalId) ids.add(row.externalId);
    }
    return { sessions: [...ids] };
  },
  superScopes: ["read:sessions", "read:all", "admin"],
},
```

**Why three IDs in the resource set?** `checkAuthorization` is "any-match"
across the resource values. We want a JWT scoped to *either* form to
authorize *either* URL form. Smoke test verified the 4-cell matrix passes.

**The PUT path** (action handler) is simpler — it just resolves the row,
builds an addressing key, and hands it to `initializeSessionStream`. Worth
noting the `closedAt` check is now `maybeSession?.closedAt` — no row means
no closedAt to enforce.

### 3. `apps/webapp/app/routes/realtime.v1.sessions.$session.$io.append.ts` (+22/-13)

POST append (browser writes a record to `.in` or server writes to `.out`).
Same row-optional pattern. Both the S2 append and the waitpoint drain use
`addressingKey`.

**Question to ask:** what fires the waitpoint? An agent's
`session.in.wait()` registers a waitpoint keyed on `(addressingKey, io)` via
the wait endpoint (file 4). The append handler drains by the *same* key —
even if the agent registered with externalId form and the transport
appended via friendlyId form, both compute the same canonical key, so they
converge. ✓

### 4. `apps/webapp/app/routes/api.v1.runs.$runFriendlyId.session-streams.wait.ts` (+18/-13)

The agent's `.in.wait()` endpoint. Run-engine creates the waitpoint, then
registers it in Redis under `(addressingKey, io)`. The race-check that runs
right after creation reads from S2 by the same key. Three call sites —
`addSessionStreamWaitpoint`, `readSessionStreamRecords`,
`removeSessionStreamWaitpoint` — all consistent.

### 5. `apps/webapp/app/routes/api.v1.sessions.ts` (+4/-2)

**Security tightening.** Removed `allowJWT: true` and `corsStrategy: "all"`
from the `POST /api/v1/sessions` action — secret-key only now.

**Question to ask:** was the JWT path actually used? Until this branch, the
transport called it via `ensureSession` (now deleted). After this branch,
nobody reaches it from the browser. `chat.createTriggerAction` (server
secret key) is the only browser-adjacent path.

### 6. `packages/trigger-sdk/src/v3/ai.ts` (+62/-39)

Two near-identical edits — one in `chatAgent`, one in `chatCustomAgent`.
Both bind on `payload.chatId` and fire-and-forget the upsert:

```ts
locals.set(chatSessionHandleKey, sessions.open(payload.chatId));
void sessions
  .create({ type: "chat.agent", externalId: payload.chatId })
  .catch(() => { /* best effort */ });
```

**Question to ask:** why `void`-and-`catch`? Awaiting the upsert would gate
the agent's bind on a network round-trip that doesn't unblock anything
user-visible — `.in/.out` routes are row-agnostic and the waitpoint cache
is keyed on the addressing string, not the row id. If the upsert genuinely
fails, the next bind retries the same idempotent call (`sessions.create`
upserts on `externalId`, so concurrent triggers on one chatId converge to
one row). The row matters for downstream metadata + listing, not for live
addressing.

The PAT scope minting in `chatAgent` (two call sites — preload and
sendMessage) now uses `payload.chatId` for the `sessions:` resource. That
matches what the transport/AgentChat use as the JWT resource and what the
JWT's resource set in the loader includes. Cross-form addressing works
either way (smoke-tested), but using `chatId` keeps the chain tight.

`createChatTriggerAction` is the most visibly trimmed: no pre-create, no
threading `sessionId` into payload, scope mint uses `chatId`. Return type
no longer carries `sessionId` — note `TriggerChatTaskResult.sessionId` was
already declared optional, so this isn't a public-API break.

**Stale docstring to flag:** `chat.ts:59` and `chat.ts:112` still describe
PAT scopes as `read:sessions:{sessionId}` and
`write:sessions:{sessionId}`. Functionally either ID works (row lookup
canonicalises), but the doc text is now out of date — it should say
`{chatId}`. Worth a tidy-up before merge but not blocking.

### 7. `packages/trigger-sdk/src/v3/chat.ts` (+63/-117)

**The biggest mechanical edit.** Net -54 lines from deleting `ensureSession`
and untangling its callers.

What disappeared:
- `private async ensureSession(chatId)` — gone
- The "lazy upsert from the browser if no triggerTask callback" branch in
  `sendMessages` and `preload` — gone
- The "throw if neither path surfaced a sessionId" guard — gone
- All `state.sessionId` URL params replaced with `chatId`
- `subscribeToSessionStream`'s `chatId?` (optional) is now `chatId` (required)

What stayed:
- `state.sessionId` in `ChatSessionState` — optional, informational
- The `restore from external storage` branch in the constructor still
  hydrates `sessionId` if persisted, just doesn't *require* it
- `notifySessionChange` still surfaces `sessionId` if known

**Question to ask:** does the transport ever still need the friendlyId? The
only place is the `onSessionChange` callback's payload (so consumers
persisting state can save it for later display). The transport itself never
puts it in a URL or a waitpoint key.

The `sendMessages` path is worth re-reading: when state.runId is set, it
appends to `.in/append` and subscribes to `.out`. If the append fails with
a non-auth error, it falls through to triggering a new run (legacy "run is
dead" detection — unchanged from pre-Sessions, doesn't depend on
addressing).

### 8. `packages/trigger-sdk/src/v3/chat-client.ts` (+34/-33)

Server-side `AgentChat`. Mirrors the transport changes — every URL uses
`this.chatId`. `triggerNewRun` no longer pre-creates a session. `ChatSession`
and internal `SessionState` types now have optional `sessionId`.

The shape of the diff is identical to the transport: delete the upsert,
swap addressing identifiers, optionalise the friendlyId. If you've read
`chat.ts` carefully, this one is mostly mechanical confirmation that both
client surfaces (browser transport + server-side AgentChat) speak the same
addressing protocol.

### 9. Test infrastructure — `sessions.ts` (+18) + `mock-chat-agent.ts` (+25)

`__setSessionCreateImplForTests` mirrors the existing
`__setSessionOpenImplForTests`. `mockChatAgent` installs a no-op create stub
returning a synthetic `CreatedSessionResponseBody` so the agent's bind-time
`void sessions.create(...)` doesn't try to hit a real API. Cleanup runs in
the same `.finally` as the open override.

**Question to ask:** is the synthetic response shape correct? It mirrors
`CreatedSessionResponseBody` — `id`, `externalId`, `type`, `tags`,
`metadata`, `closedAt`, `closedReason`, `expiresAt`, `createdAt`,
`updatedAt`, `isCached`. Tests don't currently assert on this object, so
the bar is "doesn't crash + matches the type". Met.

### 10. `packages/trigger-sdk/src/v3/chat.test.ts` (+13/-12)

Three classes of test edits, all consequences:

- Stream URL assertion: `chat-1` (the chatId) instead of
  `session_streamurl` (the friendlyId)
- `renewRunAccessToken` callback: `sessionId: undefined` (was
  `DEFAULT_SESSION_ID` because the mocked trigger doesn't surface it)
- Token resolve count: `1` (was `2` — second resolve was for `ensureSession`)
- One `onSessionChange` matchObject loses `sessionId`

### 11. `apps/webapp/app/routes/_app.../playground/.../route.tsx` (1 line)

`sessionId: string` → `sessionId?: string` in the playground sidebar prop
to track the transport type change.

---

## Edge cases I checked, so you don't have to

- **Cross-form JWT auth (curl matrix).** JWT scoped to externalId can call
  externalId URL ✓ and friendlyId URL ✓. JWT scoped to friendlyId can call
  externalId URL ✓ and friendlyId URL ✓. Smoke-tested.
- **Row materialises after subscribe.** Transport opens
  `GET /sessions/{chatId}/out` before agent's bind upsert lands → 200 OK,
  `addressingKey = chatId` (paramSession fallback). Once the row lands
  with `externalId = chatId`, addressingKey resolves to the same value via
  `row.externalId`. Same S2 key throughout.
- **Concurrent triggers on one chatId.** Two browser tabs trigger two runs
  → two binds → two `sessions.create({externalId: chatId})` calls. Upsert
  semantics: both return the same row.
- **Closed session enforcement.** Still enforced when a row exists.
  `maybeSession?.closedAt` is null-safe; no row = no close-state to honour.
- **Agent run cancellation.** Frontend doesn't auto-detect — unchanged from
  pre-Sessions; messages sit in S2 until the next trigger (the existing
  run-PAT auth-error path is the only reaper). Out of scope for this branch.
- **Idle timeout in dev.** Runs stay `EXECUTING_WITH_WAITPOINTS` past the
  configured idle because dev runs don't snapshot/restore; the in-process
  idle clock advances locally without touching the row. Expected, not a
  regression.

## Things explicitly **not** in this branch

- Run-state subscription on the transport side (the "run died, re-trigger
  silently" UX gap)
- Session auto-close on agent exit (still client-driven by design)
- Any change to `Session` schema, `sessions.create` semantics, or
  `chatAccessTokenTTL`
- Docstring updates for `read:sessions:{sessionId}` / `write:sessions:{sessionId}`
  in `chat.ts:59` and `chat.ts:112` (functional but textually stale —
  follow-up nit)

---

## What I'd be ready to answer cold

- Why fire-and-forget upsert (vs. `await`) in the agent's bind step
- Why the route's authorization resource set has three IDs (cross-form JWT
  auth)
- Why `POST /api/v1/sessions` lost `allowJWT` (security tightening — no
  caller needs it after the transport's `ensureSession` is gone)
- What converges two callers using different URL forms onto the same S2
  stream (`canonicalSessionAddressingKey`, identical computation on both
  sides for any given row)
- What makes `sessions.create` race-safe under concurrent triggers
  (`externalId` upsert)
- Why `state.sessionId` stayed on `ChatSessionState` at all (pure
  informational, surfaced via `onSessionChange` for consumer persistence;
  zero addressing role)
- Why the chat-client (server-side AgentChat) and chat (transport) edits
  look near-identical (they implement the same client protocol against the
  same row-agnostic routes)
