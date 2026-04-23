# Sessions as run manager

Plan for the next chat.agent / Sessions branch. Builds on the row-agnostic
addressing branch (`chat-agent-sessions.md`).

## Context

The previous branch made `chatId` (the externalId) the universal addressing
string and made the `.in/.out/wait` routes row-agnostic. It works, but the
transport still owns run lifecycle: it triggers the first run, threads
`runId` through state, has to detect "run died" so the next user message
re-triggers, and re-triggers explicitly on `trigger:upgrade-required`.

Two real gaps fall out of that:

1. **Run-death blindness.** `.in/append` is run-independent — it appends to
   S2 successfully whether or not the run is alive. The transport's
   "non-auth error → re-trigger" fallback (`chat.ts:647-654`) is dead code
   under row-agnostic addressing because the endpoint always 200s. If a run
   is cancelled or crashes mid-turn before emitting `turn-complete`, the
   user's next message sits in S2 with no listener and the transport has
   no signal to recover.

2. **Transport carries upgrade plumbing.** ~50 lines around
   `subscribeToSessionStream`'s `upgradeRetry`, threaded `payload`+
   `messages` for re-trigger, and the `triggerNewRun` call on a
   client-issued retry — all so the transport can react to a chunk the
   agent emits. Server is in a better position to do this work.

The fix: **make Session the run manager.** Sessions know their task,
their config, and their current run. Server triggers/re-triggers as
needed. Browser holds a session-scoped PAT and never sees runs.

Nothing has shipped yet — no back-compat needed. We're free to break
public surface (`chat.createTriggerAction`, `onSessionChange` shape,
`ChatSession.runId`).

## Design

### Invariants

- Session is the durable identity of a chat. One session, many runs over
  its lifetime.
- Session always knows its task (`taskIdentifier`) and how to trigger it
  (`triggerConfig`). Sessions without those fields don't exist anymore —
  Sessions are task-bound by design.
- At most one live run per session at a time. Tracked as
  `Session.currentRunId` (non-FK, can lag reality).
- `Session.currentRunVersion` (monotonic int) drives optimistic locking on
  any state transition that swaps the run.
- Browser only ever holds session-scoped tokens. Run identifiers are a
  server-side implementation detail.
- The append-time probe is the source of truth. Hooks from run-engine into
  Session are optional eager-clears for dashboard freshness, never for
  correctness.

### State machine

```
        ┌─────────────────┐
        │ Session created │
        │ first run fired │
        └────────┬────────┘
                 ▼
       ┌──────────────────┐    user msg / .in append
       │ currentRun alive │ ◀────────────────────────┐
       └────────┬─────────┘                          │
                │ run terminates                     │
                │ (idle, cancel, crash, end-cont.)   │
                ▼                                    │
       ┌──────────────────┐    .in/append probes     │
       │ currentRun stale │ ─── ensureRunForSession ─┘
       └──────────────────┘
                │ session.close()
                ▼
       ┌──────────────────┐
       │ closed (terminal)│
       └──────────────────┘
```

### Three trigger paths

1. **Session create.** `POST /api/v1/sessions` creates the row and triggers
   the first run synchronously, returns `{ id, runId, publicAccessToken }`.
2. **`.in/append` probe.** Server checks `currentRunId`'s snapshot status;
   if terminal, calls `ensureRunForSession` before processing the append.
3. **`end-and-continue`.** Agent calls `POST /api/v1/sessions/:id/end-and-continue`
   to request a clean handoff to a fresh run on the latest version. Server
   triggers v2, swaps `currentRunId`, returns the new runId. v1 emits its
   final `.out` chunks (e.g. `trigger:upgrade-required` for transport
   telemetry) and exits.

## Schema

### Prisma changes

```prisma
model Session {
  // existing fields stay...

  // Now required (today nullable). Sessions are task-bound.
  taskIdentifier   String

  // New: trigger payload + options for re-runs.
  // { basePayload, machine, queue, tags, maxAttempts, idleTimeoutInSeconds }
  triggerConfig    Json

  // New: current run pointer. Non-FK so run deletion doesn't cascade.
  currentRunId     String?

  // New: monotonic counter for optimistic locking on currentRunId swaps.
  currentRunVersion Int       @default(0)

  @@index([currentRunId])  // only useful for "find session by run" reverse lookups
}
```

### Optional historical join (defer to v1.1)

```prisma
model SessionRun {
  sessionId    String
  runId        String   @unique
  reason       String   // "initial" | "continuation" | "upgrade" | "manual"
  triggeredAt  DateTime @default(now())

  @@index([sessionId])
}
```

Not strictly needed for v1 — debugging/audit can use TaskRun's existing
metadata + `Session.currentRunId` history via `git`-style logs in
ClickHouse if desired. Add only if a concrete dashboard surface needs it.

### Migration

Two-step:

1. Add the new columns + populate `taskIdentifier` from existing data
   (chat.agent sessions all have it implicit via tags or metadata).
2. Set `triggerConfig = '{}'` for any existing sessions and either close
   them or leave them as zombies. Since the old transport still works
   pre-merge, this branch is the cutover.

For the dev DB: I'll write a backfill that closes existing dev sessions
rather than try to compute valid triggerConfigs for them. They were all
test data anyway.

## API surface

### `POST /api/v1/sessions` — modified

Two auth modes:

| Mode        | Caller                  | Required scope                | Notes                                              |
| ----------- | ----------------------- | ----------------------------- | -------------------------------------------------- |
| Secret key  | Customer's server       | env-wide                      | `chat.createStartSessionAction` server action      |
| One-time JWT| Browser                 | `trigger:tasks:{taskId}`      | Mints via `auth.createTriggerPublicToken(taskId)`  |

Body (Zod-validated):

```ts
{
  type: string,                            // existing
  externalId?: string,                     // chatId for chat.agent
  taskIdentifier: string,                  // required; must match scope if JWT
  triggerConfig: {
    basePayload: Record<string, unknown>,
    machine?: MachinePresetName,
    queue?: string,
    tags?: string[],                       // ≤5
    maxAttempts?: number,
    idleTimeoutInSeconds?: number,
  },
  tags?: string[],                         // existing — session-level tags
  metadata?: Record<string, unknown>,      // existing
}
```

Response:

```ts
{
  id: string,                              // session_*
  runId: string,                           // first run, freshly triggered
  publicAccessToken: string,               // session-scoped, long TTL
  externalId: string | null,
  type: string,
  // ... rest of SessionItem fields
}
```

Behavior:

- Idempotent on `(env, externalId)`. Repeat calls return the existing
  session, ensure-running its run if terminal, return a fresh PAT.
- Token consumption: if JWT mode, the one-time token is consumed on first
  successful call (existing replay-protection infra).
- PAT scopes returned: `read:sessions:{externalId} + write:sessions:{externalId}`.
  No run-scoped permissions — the transport doesn't need them.

### `POST /api/v1/sessions/:id/in/append` — modified

Add the probe + ensure-run step before the existing S2 append. Pseudocode:

```ts
const sess = await readSession(id);
if (sess.closedAt) return 400;
if (sess.expiresAt && sess.expiresAt < now) return 400;

if (!sess.currentRunId || isTerminal(await getSnapshotStatus(sess.currentRunId))) {
  await ensureRunForSession(sess);  // see below
}

return appendToS2(addressingKey, body);  // unchanged
```

The probe is one Redis snapshot read (`getSnapshotStatus` is cheap,
already used by the run-engine). Net hot-path overhead: ~1ms.

### `POST /api/v1/sessions/:id/end-and-continue` — new

Called by the run itself (uses internal run auth, scoped to the
calling run's id + the session id). Triggers a fresh run for the same
session, atomically swaps `currentRunId`, returns the new runId.

Body:

```ts
{
  reason: "upgrade" | "explicit-handoff" | string,
  // optional metadata for SessionRun.reason if/when we add the join table
}
```

Response:

```ts
{ runId: string }
```

The calling run is expected to exit shortly after receiving the response —
it has done whatever wrap-up it wanted and is delegating the conversation
to the new run. The transport sees this as "more chunks arrive on `.out`,
some from v1 then some from v2" — it's the same S2 stream keyed on chatId.

### Other routes — unchanged

`GET /api/v1/sessions/:id`, `PATCH /api/v1/sessions/:id` (close, update),
`PUT /realtime/v1/sessions/:id/:io`, `GET /realtime/v1/sessions/:id/:io`
(SSE subscribe, including the row-agnostic addressing from the previous
branch) — all stay the same.

## Server internals

### `ensureRunForSession` — atomic re-run via optimistic locking

Lives in a new service: `apps/webapp/app/services/realtime/sessionRunManager.server.ts`.

```ts
async function ensureRunForSession(
  sess: SessionRow,
  reason: "initial" | "continuation" | "upgrade" | "manual"
): Promise<{ runId: string }> {
  // 1. Trigger the run upfront. Cheap to cancel if we lose the race.
  const newRun = await triggerTaskInternal(sess.taskIdentifier, sess.triggerConfig);

  // 2. Try to claim the slot.
  const claimed = await prisma.session.updateMany({
    where: {
      id: sess.id,
      currentRunVersion: sess.currentRunVersion,
    },
    data: {
      currentRunId: newRun.id,
      currentRunVersion: { increment: 1 },
    },
  });

  if (claimed.count === 1) {
    // Optionally record SessionRun history here.
    return { runId: newRun.id };
  }

  // 3. Lost the race. Cancel ours, reuse whoever won.
  cancelTaskRun(newRun.id).catch(() => {/* fire-and-forget */});
  const fresh = await readSession(sess.id);
  if (fresh.currentRunId && !isTerminal(await getSnapshotStatus(fresh.currentRunId))) {
    return { runId: fresh.currentRunId };
  }

  // 4. Pathological: winner's run died between win and our re-read. Recurse.
  return ensureRunForSession(fresh, reason);
}
```

Key properties:
- No DB lock held across the trigger network call.
- Wasted-trigger window is small and bounded (multi-tab race on dead run,
  ms apart). Cancel cost is negligible.
- Recursion only on pathological double-failure; bounded by run-engine's
  own progress.

### Run-engine eager-clear (optional, defer)

A run-engine post-termination hook that nulls `Session.currentRunId` when
the terminal run matches. Purely a dashboard freshness concern. Skip in
v1 — append-time probe is the source of truth.

## SDK changes

### Transport (`packages/trigger-sdk/src/v3/chat.ts`)

State collapses to:

```ts
type ChatSessionState = {
  publicAccessToken: string;          // session-scoped, long TTL
  lastEventId?: string;               // for SSE resume
  isStreaming?: boolean;              // for reconnect-on-reload UX
  skipToTurnComplete?: boolean;       // for stop+resume UX
};
```

Note: no `runId`, no `sessionId`. The chat is the chatId; the token is
session-scoped.

Removed:
- `triggerTaskFn` callback option (constructor branch on it)
- `triggerNewRun()` method
- `renewRunPatForSession()`
- `renewRunAccessToken` callback option (token is session-scoped, doesn't
  expire on run boundaries)
- `ensureSession()` (already removed in previous branch)
- The `trigger:upgrade-required` re-trigger handler in
  `subscribeToSessionStream` (~50 lines)
- The `upgradeRetry: { payload, messages }` parameter threaded through
  `sendMessages`, `preload`, `subscribeToSessionStream`
- The non-auth-error fallback in `sendMessages` (dead code, removed)

Renamed/replaced:
- `chat.createTriggerAction` → `chat.createStartSessionAction`
  - Calls `sessions.create({ taskIdentifier, externalId, triggerConfig })`
    server-side with secret key
  - Returns `{ publicAccessToken }` (no runId — invisible to browser)

New methods:
- `transport.start(chatId, opts)` — for the browser-mediated path:
  - Customer provides a `getStartToken(taskId)` callback that mints the
    one-time JWT
  - Transport calls `POST /sessions` with that token
  - Receives session PAT, stores as state.publicAccessToken
- `transport.preload(chatId)` — same shape as `start` but with empty
  basePayload override

Method behavior changes:
- `sendMessages` — no trigger logic. Always `.in/append`. Server triggers
  if needed. On 401/403, error out (token expired — customer's token
  callback should provide fresh).
- `subscribeToSessionStream(chatId)` — pure passthrough on `.out`. Filters
  `trigger:upgrade-required` for cleanliness (server handles the re-run
  swap). Filters `trigger:turn-complete` as today.
- `stopGeneration` — `.in/append` with `{ kind: "stop" }`. Unchanged.
- `getSession(chatId)` — returns `{ publicAccessToken, lastEventId, isStreaming }`.
  No id fields.

### `chat-client.ts` (server-side AgentChat)

Mirror the transport: state without `runId`/`sessionId`, no `triggerNewRun`,
constructor takes `{ chatId, publicAccessToken }` (or mints via secret
key). All `.in/append` and `.out` URLs use `chatId`.

### `chat.agent` runtime (`packages/trigger-sdk/src/v3/ai.ts`)

- Drop the fire-and-forget `sessions.create({ externalId: chatId })` at
  bind. Session already exists by the time the agent boots — server
  triggers via `ensureRunForSession` after creating the row.
- Keep `sessions.open(payload.chatId)` for helper resolution. No change.
- `chat.requestUpgrade()` plumbing: calls `POST /sessions/:id/end-and-continue`
  with the run's internal auth. On success, emits `trigger:upgrade-required`
  on `.out` for telemetry, exits cleanly.

### Reference projects (`references/ai-chat`)

- `actions.ts`: replace `chat.createTriggerAction` callsite with
  `chat.createStartSessionAction`
- `chat-app.tsx`: pass the new `start` mode to `useTriggerChatTransport`
- `chat.tsx`: drop `runId` references
- `trigger/chat.ts`: no changes (chat.agent contract unchanged from
  agent-author POV)

## Auth model summary

| Token                         | Scopes                                                 | Where minted                              | Lifetime    |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------- | ----------- |
| Trigger-task one-shot         | `trigger:tasks:{taskId}`                               | `auth.createTriggerPublicToken(taskId)`   | One use     |
| Session PAT                   | `read:sessions:{ext} + write:sessions:{ext}`           | Issued by `POST /sessions`                | 1h–24h      |
| Run-internal PAT (chat.agent) | `read:runs:{run} + read:sessions:{ext} + …`            | Server-side, never crosses to browser     | Run-bounded |

Browser holds at most a one-shot token (briefly) and a session PAT
(steady state). Never holds a run-scoped token.

## Edge cases

- **Concurrent multi-tab on dead run** — optimistic locking handles it,
  loser cancels its triggered run.
- **Page refresh mid-stream** — `.out` SSE resumes via Last-Event-ID
  (existing); session PAT survives because it's not run-scoped.
- **Run cancelled by user (dashboard)** — append-time probe sees terminal,
  triggers new run on next message.
- **Idle exit** — same path; user comes back later, sends message, fresh
  run boots.
- **Crash mid-turn (no `turn-complete` emitted)** — same path; persisted
  store is pre-turn, fresh run reads `.in` from tail position, picks up
  unanswered message.
- **Upgrade during user message** — optimistic locking in
  `end-and-continue` ensures one wins. If user message wins,
  `end-and-continue` returns conflict, agent v1 keeps running, processes
  message, retries upgrade later. If upgrade wins, user message's append
  probes fresh `currentRunId` (v2), uses it.
- **Session expiry mid-conversation** — `.in/append` and `end-and-continue`
  reject after `expiresAt`. Existing run keeps running until idle, then
  exits. Frontend sees a 400.
- **Concurrent `POST /sessions`** — unique constraint on
  `(env, externalId)`, idempotent upsert returns existing row + ensure-runs.

## Tests

### Unit

- `ensureRunForSession`:
  - Happy path (no contention)
  - Concurrent contention (two callers, one wins, loser reuses winner's
    run)
  - Pathological recursion (winner's run dies before loser re-reads)
  - Trigger failure (caller's responsibility to surface)
- `POST /sessions` route:
  - Idempotent upsert (same externalId → same row, fresh PAT)
  - Auth: secret key path, JWT path with valid scope, JWT path with wrong
    task scope (403), JWT replay (consumed token rejected)
  - First run triggered, runId in response
- `POST /sessions/:id/in/append`:
  - Probe path: alive run, terminal run, null currentRunId
  - Probe + trigger: ensure new run before append
  - Closed session 400
  - Expired session 400
- `POST /sessions/:id/end-and-continue`:
  - Auth: only callable from the current run
  - Optimistic locking: stale currentRunId loses gracefully

### Integration

- chat.test.ts rewrite around the new transport surface (no `runId`,
  no `triggerNewRun`)
- mock-chat-agent harness updates: install `__setSessionCreateImplForTests`
  to also stub the first-run trigger (the create + trigger is now atomic
  on the server, so the test harness needs to surface a fake runId)

### Smoke (manual via Chrome DevTools)

Same checklist as the previous branch's smoke test, plus:

- Cancel run via dashboard → next user message triggers fresh run
  automatically (no longer a gap)
- Deploy a new agent version mid-conversation → existing run requests
  upgrade, exits, new run continues seamlessly (transport sees no
  interruption beyond a possible extra TTFB)

## Verification plan

Per-package:

```
pnpm run typecheck --filter webapp                     # apps + internal pkgs
pnpm run typecheck --filter @internal/run-engine
pnpm run build --filter @trigger.dev/sdk               # public package
pnpm run build --filter @trigger.dev/core              # public package
pnpm run test --filter webapp -- sessionRunManager
pnpm run test --filter @trigger.dev/sdk -- chat
```

End-to-end via the playground:

1. ai-chat (chat.agent) — basic send + reply
2. ai-chat-session (custom agent) — basic send + reply
3. ai-chat-raw — basic send + reply
4. ai-chat-hydrated — basic send + reply
5. Mid-stream reload — SSE reconnect
6. Stop + follow-up — same run handles next turn
7. Cancel run + send message → new run triggered automatically (the gap
   from previous branch's S4 — must pass cleanly here)
8. Deploy new version + send message → in-flight conversation upgrades
   transparently
9. Cross-form addressing curl matrix — unchanged from previous branch

## Rollout

- Single feature branch off `main` (or off the previous chat-agent-sessions
  branch once that lands).
- No flag, no shim. Hard cutover. Pre-release SDK version.
- Reference projects updated in the same PR so the smoke test path works.

## Open questions

1. **Should `end-and-continue` accept a custom `triggerConfig` override?**
   Use case: agent wants to swap to a different task identifier (rare).
   Probably defer — keep it strictly "trigger another run with the same
   config" for v1.
2. **Should `triggerConfig` pin the deploy version?** If a customer
   redeploys with a chat.agent contract change, in-flight sessions might
   have payloads incompatible with the new version. Probably defer —
   chat.agent contract is stable; signature-breaking changes are rare and
   warrant explicit handling.
3. **`SessionRun` join table**: yes/no/defer? Defer to v1.1 unless a
   concrete dashboard surface needs it.
4. **`getSnapshotStatus` cost on hot path** — measure before optimizing.
   Redis snapshot read should be sub-ms; if it isn't, cache for 1-2s
   per session.

## Out of scope

- Session-level retry policies (separate feature)
- Multi-run-per-session (parallel agents on one chat) — explicit
  non-goal; one currentRunId by design
- Cross-environment sessions (a session in dev, run in prod) — not
  considered
- Public `Session.requestRun()` for callers other than the running
  agent itself — defer until a use case appears
- Webhook notifications on run swap — defer

## Effort estimate

- Schema + migration: 0.5 day
- `ensureRunForSession` service + tests: 1.5 days
- `POST /sessions` auth modes + idempotent upsert + first-run trigger: 1 day
- `.in/append` probe: 0.5 day
- `end-and-continue` route + agent runtime wiring: 1 day
- Transport rewrite + tests: 2.5 days
- chat-client rewrite + tests: 1 day
- chat.agent runtime cleanup: 0.5 day
- `chat.createStartSessionAction` + browser path: 1 day
- Reference project migration: 0.5 day
- Smoke test + bug-fix buffer: 1.5 days

**~11 days** focused work. Plus design doc review and any architectural
back-and-forth — call it 2 weeks calendar.

## Implementation order

1. Schema + migration (gives the new columns; everything else builds on this)
2. `ensureRunForSession` service + unit tests (the load-bearing primitive)
3. `POST /sessions` route changes (creates a session that actually has a run)
4. `.in/append` probe path (so the server can self-heal between runs)
5. `end-and-continue` route + chat.agent runtime call (upgrade flow)
6. Transport rewrite (depends on all the server pieces)
7. chat-client rewrite (mirrors transport; cheap once that's done)
8. `chat.createStartSessionAction` + reference project migration
9. Smoke test + final bug fixes
