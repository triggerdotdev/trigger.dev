# Mollifier API parity — master plan

**Branch:** `mollifier-phase-3` (continuation)
**Date:** 2026-05-19
**Status:** Q1, Q2, Q3, Q4, Q5 all locked. Endpoint inventory complete. **Phase A complete.** Phase B is the next chunk.

## Progress tracking

> Always update this section after each phase commits, so a fresh session can resume cleanly without rereading every git log entry.

| Phase | Status | Commits | Notes |
|---|---|---|---|
| Merge of origin/main | ✅ Done | `8c01cf0eb` | 8 conflicts resolved; phase-3 versions kept; picked up one doc comment from main about shadow-mode counter writes |
| Design docs + parity script | ✅ Done | `c8d036aa0` | 6 plan docs + `scripts/mollifier-api-parity.sh` |
| **Phase A — read endpoints** | ✅ **Done** | `6b8a54e43`, `e21dbee5e` | See "Phase A patterns established" below |
| **Phase B1 — ZSET migration** | ✅ **Done** | `709d2f5af` | Score = `createdAtMicros`; requeue keeps original score (createdAt immutable across retries) — see decision below |
| **Phase B2 — drainer ack grace TTL** | ✅ **Done** | `22dbbc90f` | `ack` → `HSET materialised=true; EXPIRE 30s`. Accept refuses materialised entries (defense-in-depth) |
| **Phase B3 — mutateSnapshot Lua** | ✅ **Done** | `08f20c65f` | Three return codes, four patch types. Lua atomicity per-runId verified by 50-way concurrent test |
| **Phase B4 — SyntheticRun replay fields** | ✅ **Done** | `612babf6c` | Adds id / runtimeEnvironmentId / engine / workerQueue / queue / concurrencyKey / machinePreset / realtimeStreamsVersion / seedMetadata / seedMetadataType / runTags. Also closes a pre-existing typecheck gap in `synthesiseFoundRunFromBuffer` (workerQueue default `"main"`) |
| **Phase B5 — mutateWithFallback helper** | ✅ **Done** | `dea1c7c0d` | Discriminated outcome (pg/snapshot/not_found/timed_out); never throws Response so it's route-agnostic and unit-tested in isolation |
| **Phase B6a — buffer idempotency primitives** | ✅ **Done** | `0c7c07dd0` | accept SETNXes lookup; ack DELs it; new lookupIdempotency + resetIdempotency methods. accept return shape now discriminated `AcceptResult` |
| **Phase B6b — trigger/reset integration** | ✅ **Done** | `51b471c12` | IdempotencyKeyConcern checks both stores; ResetIdempotencyKeyService clears both; mollifyTrigger handles `duplicate_idempotency` race-loser case. resumeParentOnCompletion deliberately skipped (waitpoint needs PG row) |
| **Phase B complete** | ✅ | — | — |
| **Phase C1 — cancel** | ✅ **Done** | `d4f734213` | `engine.createCancelledRun` + drainer bifurcation + route via mutateWithFallback. Q4 design |
| **Phase C2 — tags** | ✅ **Done** | `3534f1330` | Closes the live 500 the parity script flagged. MAX_TAGS skipped on buffer side (matches today's pre-buffer trigger semantics) |
| **Phase C3 — metadata PUT** | ✅ **Done** | `d5c1e22b1` | New `casSetMetadata` Lua + `applyMetadataMutationToBufferedRun` helper. Reuses existing `applyMetadataOperations` from `@trigger.dev/core` (no Lua re-impl of the 6 operation types). Parent/root operations fanned out via the existing service against snapshot's `parentTaskRunId` |
| **Phase C4 — reschedule** | ✅ **Done** | `0183e4367` | `set_delay` patch; PG-side `RescheduleTaskRunService` still enforces non-DELAYED rejection via wait-and-bounce |
| **Phase C5 — replay** | ✅ **Done** | `0183e4367` | Read-fallback after PG miss; SyntheticRun-as-TaskRun cast (B4 work) feeds existing `ReplayTaskRunService`. Also tightens PG lookup to env-scoped findFirst |
| **Phase D — dashboard internals** | ✅ **Done** | `39e3bab39` | cancel / replay / idempotencyKey-reset dashboard routes handle buffered runs via org-membership auth |
| **Phase E — listing endpoints** | ✅ **Done** | `5b118d21e` | `MollifierBuffer.listForEnvWithWatermark` + `callRunListWithBufferMerge` wrapper. Compound base64-JSON cursor with `bufferExhausted` latch. `RecentlyQueuedSection` removed |
| Phase C — mutation endpoints | ⏳ Pending | — | cancel first (drives B), then tags/metadata-put/reschedule/replay |
| Phase D — dashboard internals | ⏳ Pending | — | reuse C paths |
| Phase E — listing endpoints | ⏳ Pending | — | Q1 design |
| Phase F — test surface lockdown | ⏳ Pending | — | strict parity script + integration tests |

## Phase A patterns established (reference for B/C/D)

Six read endpoints implemented in A1-A6. Three got new code, two needed nothing, one had a pre-existing route bug fixed:

| # | Endpoint | Implementation | Pattern used |
|---|---|---|---|
| A1 | `GET /api/v1/runs/{id}/trace` | `findResource` discriminated union → empty trace shape for buffered | New pattern (see below) |
| A2 | `GET /api/v1/runs/{id}/spans/{spanId}` | Same discriminated union → minimal span shape if spanId matches snapshot, 404 otherwise | Same as A1 |
| A3 | `GET /api/v1/runs/{id}/events` | **No change** — works via `ApiRetrieveRunPresenter.findRun`'s existing buffer fallback; querying events for a buffered traceId returns `{events:[]}` naturally | Inherits existing infra |
| A4 | `GET /api/v1/runs/{id}/result` | **No change** — existing 404 message "Run either doesn't exist or is not finished" already covers buffered (not-in-PG) and PG-delayed (not-finished) cases | No-op |
| A5 | `GET /api/v1/runs/{id}/attempts` | Added missing `loader` (route only had `action`); returns `{attempts:[]}` for both PG and buffered | New loader + parity stub |
| A6 | `GET /api/v1/runs/{id}/metadata` | Same: added missing `loader`; returns `{metadata, metadataType}` from PG or buffer snapshot | New loader + buffer probe |

### The discriminated union pattern (for A1, A2, and reusable for Phase B/C/D mutations)

```ts
type ResolvedRun =
  | { source: "pg"; run: <Prisma TaskRun shape> }
  | { source: "buffer"; run: NonNullable<Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>>> };

findResource: async (params, auth): Promise<ResolvedRun | null> => {
  const pgRun = await $replica.taskRun.findFirst({...});
  if (pgRun) return { source: "pg", run: pgRun };

  const buffered = await findRunByIdWithMollifierFallback({
    runId, environmentId: auth.environment.id, organizationId: auth.environment.organizationId,
  });
  if (buffered) return { source: "buffer", run: buffered };
  return null;
}

authorization.resource: (resolved) => {
  if (resolved.source === "pg") { /* existing PG-shape resources */ }
  else { /* synthetic from SyntheticRun shape (no batchId; tags from buffered.tags) */ }
}

handler: async ({ resource: resolved }) => {
  if (resolved.source === "buffer") {
    // synthesise endpoint-specific empty/minimal shape
    return json({...}, { status: 200 });
  }
  // existing PG handler logic
}
```

**Important detail:** `SyntheticRun` (in `apps/webapp/app/v3/mollifier/readFallback.server.ts`) lacks a `batchId` field. Buffered runs have no `batch` (batchTrigger bypasses the gate by design). The authorization branch for buffer source must not include batch resources.

### What's NOT in `SyntheticRun` today

If Phase B/C endpoints need additional fields from the buffer snapshot, extend `SyntheticRun` in `readFallback.server.ts`. Current fields cover: friendlyId, status, taskIdentifier, createdAt, payload, payloadType, metadata, metadataType, idempotencyKey, idempotencyKeyOptions, isTest, depth, ttl, tags, lockedToVersion, resumeParentOnCompletion, parentTaskRunId, traceId, spanId, parentSpanId, error. Missing: `taskEventStore`, `runtimeEnvironmentId`, `concurrencyKey`, `machinePreset`, `workerQueue`, `realtimeStreamsVersion`, `idempotencyKeyExpiresAt`, `seedMetadata`, `seedMetadataType`, `parentSpanId` etc. needed by various downstream services (replay, etc).

Q2 (replay) explicitly calls out the synthesiser extension — when implementing Phase C5 (replay), extend `SyntheticRun` with the full set of fields `ReplayTaskRunService` reads.

## Phase B — shared infrastructure (in progress)

Start here. Implements the building blocks that unblock Phase C. Detailed in [`2026-05-19-mollifier-listing-design.md`](2026-05-19-mollifier-listing-design.md) (Q1), [`2026-05-19-mollifier-mutation-race-design.md`](2026-05-19-mollifier-mutation-race-design.md) (Q3), and [`2026-05-19-mollifier-idempotency-design.md`](2026-05-19-mollifier-idempotency-design.md) (Q5).

### B1 — Decision recorded (commit `709d2f5af`)

Q1 underspecified the requeue case. Resolution: **ZSET score == `createdAtMicros`, immutable across retries.** Requeue does not bump the score, so a retried entry continues to pop next (oldest first). The drainer's `maxAttempts` bounds the retry loop. This keeps the listing-pagination invariant (score == createdAt) clean — no need for a separate "lastQueuedMicros" field. The existing "requeue lands at back" test was inverted to assert "requeue lands at front" — that's the correct behavior under this invariant.

Order:

- **B1.** ✅ Done (`709d2f5af`). ZSET migration in `packages/redis-worker/src/mollifier/buffer.ts`. `acceptMollifierEntry` Lua → `ZADD queue createdAtMicros runId`. `popAndMarkDraining` Lua → `ZPOPMIN`. `requeueMollifierEntry` Lua → `ZADD` reusing the original createdAtMicros. Listing read via `ZREVRANGE`. **Forward-compat note for rollout:** new entries carry the `createdAtMicros` hash field; pre-deploy in-flight entries lack it and would fail schema parse — handle via Phase F4 forward-compat tests when deploying.
- **B2.** Drainer ack semantics — replace `DEL entry` with atomic `HSET materialised=true; EXPIRE +30s`. Touches `MollifierBuffer.ack` + the underlying Lua.
- **B3.** `MollifierBuffer.mutateSnapshot(runId, patch)` — atomic Lua. Three return codes: `applied_to_snapshot`, `not_found`, `busy`. Patch types: `append_tags`, `set_metadata`, `set_delay`, `mark_cancelled`. Idempotency-key patch comes in Q5 work.
- **B4.** Snapshot-to-TaskRun synthesiser extension — extend `SyntheticRun` in `readFallback.server.ts` to include the fields `ReplayTaskRunService` reads (see Q2 doc table). The Phase C5 work depends on this.
- **B5.** `mutateWithFallback` helper in `apps/webapp/app/v3/mollifier/mutateWithFallback.server.ts`. Signature in Q3 doc (`bufferPatch`, `pgMutation`, `synthesisedResponse`, optional `maxWaitMs`). Composes Lua call + writer-side spin-wait for the busy case.
- **B6.** Idempotency lookup wiring per Q5 — extend `acceptMollifierEntry` Lua with SETNX on `mollifier:idempotency:{env}:{task}:{key}`; extend ack Lua with DEL of same; add `lookupIdempotency` and `resetIdempotency` methods.

Phase B has no customer-visible API changes by itself. It's the substrate for Phase C.

## Phase C — mutation endpoints (after B)

Order:

- **C1.** Cancel — drives the drainer-bifurcation work in `engine.createCancelledRun` (Q4 design). Hardest first.
- **C2.** Tags — fixes the live 500 documented in the parity script results.
- **C3.** Metadata PUT — straight snapshot patch.
- **C4.** Reschedule — snapshot patch on `delayUntil`; PG-side terminal-status rejection (status !== "DELAYED") inherits naturally via wait-and-bounce.
- **C5.** Replay — extend `SyntheticRun` (B4), pass synthesised TaskRun to existing `ReplayTaskRunService`.

## Resuming guidance for a fresh session

If context is lost and a new session needs to resume:

1. `git log --oneline -10 mollifier-phase-3` to see what's been done.
2. Read this master plan's **Progress tracking** section.
3. For each unfinished phase, read its companion design doc.
4. The bash parity script (`scripts/mollifier-api-parity.sh`) is the integration regression guard — run it after each phase to see drift count drop.
5. The discriminated-union pattern from Phase A is the reference shape for Phase B/C `findResource` work. Don't reinvent.
6. `SyntheticRun` in `readFallback.server.ts` is the canonical "what fields does the buffer snapshot expose to consumers" type. Extend it (never recreate) when Phase C endpoints need more fields.
7. **All five Q-docs are locked** — don't relitigate decisions. If a design corner needs revision, update the relevant Q doc + bump the master plan's status line.

## Why this exists

The mollifier buffer is currently a per-org opt-in burst-protection layer. Directional goal: every trigger eventually starts its life in Redis and materialises to PG asynchronously. The API surface must behave identically whether the run is in Redis, in PG, or in transit between them.

The bash parity script (`scripts/mollifier-api-parity.sh`) demonstrated 6 customer-visible drifts between control (PG, DELAYED) and buffered (Redis-only) runs, plus a 500 leak on `tags`. This plan covers closing all of them and locking the parity behaviour against regression.

## The invariant (drives every endpoint design)

> Anywhere the API would mutate or read a PG `TaskRun` row, the buffer entry is an equally-authoritative source of state for that run until materialisation completes. Mutations during the buffered window are applied to the snapshot; reads during the buffered window are synthesised from the snapshot; transitions are atomic per-store (Lua in Redis, transactions in PG).

The entry hash persists past materialisation as a safety net (Q1). The drainer terminates each entry in one of two states: PG row materialised (success) or PG SYSTEM_FAILURE row (failure). Either way, the next PG findFirst hits.

## Endpoint inventory

### Customer-facing API (12 endpoints — SDK reachable)

**Reads — need transparent fallback to buffer when PG row absent:**

| # | Endpoint | Current behaviour | Target |
|---|---|---|---|
| 1 | `GET /api/v3/runs/{id}` | ✓ already has read-fallback via `ApiRetrieveRunPresenter` | unchanged |
| 2 | `GET /api/v1/runs/{id}/trace` | 404 on buffered | 200 with empty trace shape |
| 3 | `GET /api/v1/runs/{id}/spans/{spanId}` | not yet probed; likely 404/500 | 200 if `spanId` matches snapshot's `spanId`, deterministic 404 otherwise |
| 4 | `GET /api/v1/runs/{id}/events` | 200 `{events:[]}` accidental | explicit contract: 200 `{events:[]}` |
| 5 | `GET /api/v1/runs/{id}/result` | 404 accidental | explicit contract: 404 `{error:"Run either doesn't exist or is not finished"}` |
| 6 | `GET /api/v1/runs/{id}/attempts` | 400 (pre-existing route-bug: no `loader`) | fix route, then 200 `{attempts:[]}` |
| 7 | `GET /api/v1/runs/{id}/metadata` | 400 (same pre-existing bug) | fix route, then 200 with snapshot metadata |

**Mutations — see Q3 design doc for the wait-and-bounce flow, Q4 for cancel bifurcation:**

| # | Endpoint | PG behaviour | Buffered-side strategy |
|---|---|---|---|
| 8 | `POST /api/v1/runs/{id}/tags` | `setRunTags` service | snapshot patch via `mutateSnapshot('append_tags', ...)`; wait-and-bounce if busy |
| 9 | `PUT /api/v1/runs/{id}/metadata` | metadata setter | snapshot patch (`set_metadata`); wait-and-bounce if busy |
| 10 | `POST /api/v1/runs/{id}/reschedule` | `RescheduleTaskRunService` (refuses non-DELAYED) | snapshot patch (`set_delay`); wait-and-bounce if busy. PG-side terminal-status rejection inherits naturally |
| 11 | `POST /api/v1/runs/{id}/replay` | `ReplayTaskRunService` (no status check) | resolve snapshot, synthesise TaskRun, call existing service (Q2 design) |
| 12 | `POST /api/v2/runs/{id}/cancel` | `CancelTaskRunService` | snapshot patch (`mark_cancelled`) + **drainer bifurcation** to write CANCELED PG row directly (Q4 design) |

### Listing endpoints (2 — Q1 design)

| # | Endpoint | Strategy |
|---|---|---|
| 13 | `GET /api/v1/runs` | ZSET-backed buffer + PG presenter merge via compound cursor; banner removed; transparent QUEUED-row display |
| 14 | `GET /api/v1/projects/{projectRef}/runs` | same |

### Dashboard internals (3 — same logic, different call sites)

| # | Endpoint | Notes |
|---|---|---|
| 15 | `POST /resources/taskruns/{runParam}/cancel` | reuses #12's path |
| 16 | `POST /resources/taskruns/{runParam}/replay` | reuses #11's path |
| 17 | `POST /resources/orgs/.../runs/{runParam}/idempotencyKey/reset` | Q5 — needs PG-side audit first |

### Out of scope (deferred or N/A)

- **Realtime** (`input-streams/wait`, `session-streams/wait`, `/realtime/v1/*`) — deferred per `_plans/2026-05-13-mollifier-electric-integration.md`. Docs note: *"During platform-imposed buffering windows, realtime streams may be temporarily silent."*
- **Worker/supervisor `engine.v1.*` endpoints** — operate on running runs only; a buffered run has no worker. Natural 404 is semantically correct.
- **`batchTrigger`** — gate bypasses by design (audit of `batchTriggerV3.server.ts` confirmed zero references to `evaluateGate` or `getMollifierBuffer`). No buffered runs from this path.
- **V1 engine path** — `triggerTaskV1.server.ts` doesn't go through mollifier at all.

## Locked sub-designs (linked docs)

| # | Topic | Locked design |
|---|---|---|
| Q1 | Listing & pagination | [`2026-05-19-mollifier-listing-design.md`](2026-05-19-mollifier-listing-design.md) — ZSET buffer + compound cursor + no banner |
| Q2 | Replay of failed buffered runs | [`2026-05-19-mollifier-replay-design.md`](2026-05-19-mollifier-replay-design.md) — single code path, PG-or-buffer resolution, state-3 allowed |
| Q3 | Mutate-vs-drain race | [`2026-05-19-mollifier-mutation-race-design.md`](2026-05-19-mollifier-mutation-race-design.md) — wait-and-bounce; 2s safety net; existing services handle terminal-state policy |
| Q4 | Cancel drainer-bifurcation | [`2026-05-19-mollifier-cancel-design.md`](2026-05-19-mollifier-cancel-design.md) — `mark_cancelled` patch, drainer routes to `engine.createCancelledRun`, single `runCancelled` event side effect |
| Q5 | Idempotency keys in both stores | [`2026-05-19-mollifier-idempotency-design.md`](2026-05-19-mollifier-idempotency-design.md) — Redis lookup atomic with accept/ack; trigger-time dedup checks both stores; reset clears both |

## Architectural building blocks

### From Q1 (listing)

- **Buffer storage migration: LIST → ZSET** keyed by createdAt micros. `mollifier:queue:{envId}` becomes a sorted set.
  - `accept`: `ZADD` instead of `LPUSH`.
  - `drainer.pop`: `ZPOPMIN` (FIFO) instead of `LPOP` (LIFO).
  - listing: `ZREVRANGEBYSCORE` with a `(createdAt, runId)` cursor anchor.
- **Drainer ack semantics change**: `DEL entry` → `HSET materialised=true; EXPIRE +30s`. Entry hash persists as safety-net read source for the grace window.
- **Compound listing cursor**: `{ watermark: (createdAt, runId), bufferExhausted: boolean }`. Opaque, base64-JSON, drop-in.
- **`MollifierBuffer.countForEnv`** kept for operator/admin dashboards only; off the customer hot path.
- **`RecentlyQueuedSection` component deleted.** Buffered runs appear as normal `QUEUED` rows in the runs table.

### From Q2 (replay)

- **Snapshot-to-TaskRun synthesiser**: extends `findRunByIdWithMollifierFallback` to return a full `TaskRun`-shaped object (not just retrieve-shape) so `ReplayTaskRunService.call(taskRun, ...)` works against either real or synthesised inputs.
- **No new infrastructure** beyond the synthesis helper.

### From Q3 (mutation race)

- **`MollifierBuffer.mutateSnapshot(runId, patch)`** — atomic Lua script. Three return codes: `applied_to_snapshot`, `not_found`, `busy`.
- **Patch types**: `append_tags`, `set_metadata`, `set_delay`, `mark_cancelled`. (Add `reset_idempotency_key` in Q5 if audit confirms.)
- **`waitForDrainerResolution(runId, abortSignal)`** — writer-side PG polling with 2s safety net; respects abort signal.
- **`pgFindWithTimeout`** — wraps Prisma findFirst with a 50ms inner timeout; prevents a slow PG query from burning the safety net.

### From Q4 (cancel, proposed)

- **`engine.createCancelledRun(input)`** — new method in `@internal/run-engine`. Writes TaskRun row in `CANCELED` state directly. Emits `runCancelled` event so existing `runEngineHandlers.server.ts` listeners fire normally. Skips queue insertion entirely.
- **Drainer bifurcation** in `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`: pop reads snapshot, checks `cancelledAt`, routes to either `createCancelledRun` or `trigger`.

## TDD plan — execution order

Discipline: for every gap, write a failing test first (matching the parity script's expected behaviour), then implement, then watch the test pass + the parity script's drift count drop.

### Phase A — Read endpoints

A1. `trace` — return empty `{trace: {traceId: snapshot.traceId, rootSpan: null, events: []}}`.
A2. `spans/{spanId}` — 200 if `spanId === snapshot.spanId`, deterministic 404 otherwise.
A3. `events` — explicit `200 {events:[]}` contract.
A4. `result` — explicit `404 {error:"Run either doesn't exist or is not finished"}` for both sides.
A5. `attempts` — fix the missing-loader route bug, then add fallback returning `{attempts:[]}`.
A6. `metadata GET` — fix missing-loader, then return `{metadata: snapshot.metadata, metadataType: snapshot.metadataType}`.

Each adds a unit test in `apps/webapp/test/api/` mirroring the route + a parity-script assertion (status + body shape).

### Phase B — Infrastructure for Q1 and Q3

B1. **ZSET migration**: `MollifierBuffer.accept` → `ZADD`; `popAndMarkDraining` Lua → `ZPOPMIN`; `requeueMollifierEntry` Lua → ZADD again. Update tests in `packages/redis-worker/src/mollifier/drainer.test.ts` and `buffer.test.ts`.
B2. **Drainer ack semantics**: replace `DEL entry` with `HSET materialised=true; EXPIRE +30s` via atomic Lua. Update `drainer.ts`.
B3. **`MollifierBuffer.mutateSnapshot`** Lua + unit tests for each patch type, terminal-state refusal, not-found refusal.
B4. **Snapshot-to-TaskRun synthesiser** extension to `readFallback.server.ts` (returns full TaskRun shape).
B5. **`waitForDrainerResolution`** helper in `app/v3/mollifier/mutateWithFallback.server.ts`.

### Phase C — Mutation endpoints

C1. **`cancel v2`** — drives drainer-bifurcation work end-to-end. Hardest first.
  - C1.1 `engine.createCancelledRun` in `@internal/run-engine` + tests (PG row written in CANCELED, runCancelled event emits, no queue insertion).
  - C1.2 Drainer bifurcation — unit test asserts `engine.trigger` is *not* called when snapshot has `cancelledAt`.
  - C1.3 Cancel route uses `mutateWithFallback` + `mark_cancelled` patch.
C2. **`tags`** — fixes the live 500.
C3. **`metadata PUT`** — straight snapshot patch.
C4. **`reschedule`** — snapshot patch on `delayUntil`; PG-side terminal-status rejection inherits naturally.
C5. **`replay`** — no special infra; read snapshot (via synthesiser), call `ReplayTaskRunService.call`.

### Phase D — Dashboard internals

D1. `resources/taskruns/{id}/cancel` — reuse C1's path.
D2. `resources/taskruns/{id}/replay` — reuse C5's path.
D3. `resources/.../idempotencyKey/reset` — Q5 audit + design + implement.

### Phase E — Listing (Q1)

E1. Listing-merge helper: `fetchBufferedRunsForListing(envId, watermark, pageSize)` + cursor encoder/decoder.
E2. `GET /api/v1/runs` — wrap presenter, integrate merge.
E3. `GET /api/v1/projects/{projectRef}/runs` — same.
E4. Delete `RecentlyQueuedSection` component, remove `countForEnv` call from runs-list loader.

### Phase F — Test surface lockdown

F1. Tighten `scripts/mollifier-api-parity.sh` — every gap from Phase A/C becomes a strict assertion.
F2. Add CI invocation — gate PRs on parity-script pass.
F3. Integration tests in `apps/webapp/test/` exercising the full burst → buffered → mutate → drain → PG flow for cancel/tags/metadata/reschedule. Asserts the materialised PG row reflects every queued mutation.
F4. Forward-compat rollout test: simulate old-drainer/new-API and new-drainer/old-API rolling-update scenarios to confirm no semantic loss (per the May-15 review meeting concern).

## Risks

- **Drainer complexity.** Bifurcation adds a third code path (`trigger` / `createCancelledRun` / `recordBufferedRunFailure`). Tests must cover the matrix: cancel-then-fail race, fail-then-cancel race, cancel-during-DRAINING, etc.
- **`engine.createCancelledRun` interactions.** Must emit the right event bus events so existing handlers fan out correctly (TaskEvent rows, run:notify, alerts). Audit `runEngineHandlers.server.ts` against the runCancelled event to confirm.
- **ZSET migration breaks drainer LIFO behaviour.** Switch to FIFO via ZPOPMIN. Confirm no existing tests or operational assumptions rely on LIFO.
- **Rolling-update version skew.** Per the May-15 meeting: deploy drainer-side changes BEFORE the API changes that depend on them. State-tag fields preferred over version counters.
- **Endpoint test surface.** 12 customer-facing × (PG + buffered) tests + dashboard internals + listing tests. The bash parity script gives integration coverage; per-endpoint unit tests give the granular regression guard. ~30 tests total.

## Definition of done

- All 12 customer-facing endpoints pass the strict parity script (`./scripts/mollifier-api-parity.sh` exits 0 with zero drifts).
- All 3 dashboard internals pass equivalent dashboard-side checks.
- All 2 listing endpoints return merged buffer + PG results with the compound cursor working across pages.
- Each endpoint has a dedicated unit test exercising both PG and buffered paths.
- One end-to-end integration test per mutating endpoint asserts the materialised PG row reflects every queued mutation after drain.
- Drainer bifurcation has tests for: normal, cancelled, failure paths, and the three race-pairs (cancel-then-fail, fail-then-cancel, cancel-during-DRAINING).
- `.server-changes/` entry for the parity rollout.
- Customer docs updated noting that the buffer is transparent for all non-realtime APIs.

## File touch estimate

**New:**
- `apps/webapp/app/v3/mollifier/mutateWithFallback.server.ts` (Q3 helper).
- `apps/webapp/app/v3/mollifier/runListMerger.server.ts` (Q1 listing helper).
- `apps/webapp/test/api/*.test.ts` (per-endpoint tests, ~14 files).
- `packages/redis-worker/src/mollifier/snapshot-patch.lua` (or inlined in buffer.ts).

**Modified:**
- Every route under `apps/webapp/app/routes/api.v[12].runs.$run*.ts` (~9 routes).
- `apps/webapp/app/routes/api.v2.runs.$runParam.cancel.ts`.
- `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts` (drainer bifurcation).
- `apps/webapp/app/v3/mollifier/readFallback.server.ts` (extend synthesiser for full TaskRun shape).
- `internal-packages/run-engine/src/engine/index.ts` (add `createCancelledRun`).
- `packages/redis-worker/src/mollifier/buffer.ts` (ZSET migration, ack change, mutateSnapshot).
- Runs-list loader (delete `countForEnv` call, integrate listing-merge helper).
- `RecentlyQueuedSection.tsx` (delete).

**Generated:**
- `.server-changes/mollifier-api-parity.md`.

~40 files touched. ~14 endpoint tests. ~6 unit tests for new infra (mutateSnapshot per patch type, ZSET migration, drainer ack, createCancelledRun, listing merge). ~4 integration tests (cancel/tags/metadata/reschedule end-to-end through drain).

## Reference: bash parity script

`scripts/mollifier-api-parity.sh` is the canonical regression guard. Latest run before Q1-Q3 lockdown:

- 5 endpoints in parity (some accidentally; tightened in Phase F1).
- 6 endpoints diverging.
- 1 endpoint 5xx leaking.

Definition of done includes "zero drifts" on the strict version.

## Reference: meeting notes that shaped this plan

- **May 15 review** (Matt + Dan): rolling-update forward-compatibility (old code must understand new format), state-tag fields preferred over version counters, drainer-as-its-own-service deploy pattern. Captured under "Rolling-update version skew" risk and "forward-compatibility" in Q3 doc.
- **Phase 3 plan** (`2026-05-11-trigger-mollifier-phase-3.md`): the original infrastructure work this builds on. Read fallback, drainer baseline, mollifier gate, all the Phase 2 ground that lets us tackle parity.
