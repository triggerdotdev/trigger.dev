# Mollifier replay design — `POST /api/v1/runs/{id}/replay` on buffered runs

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-19
**Status:** Locked. (Q2 in the api-parity plan series.)
**Companion docs:** `2026-05-19-mollifier-listing-design.md` (Q1).

## The question

The mollifier replay path needs to behave identically whether the original run lives in Postgres (any status: `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `SYSTEM_FAILURE`, `CANCELED`, etc.) or still sits in the Redis buffer (any internal state: `QUEUED`, `DRAINING`, `FAILED`, materialised-grace-window).

A buffered run can fail to materialise. The drainer pops it, calls `engine.trigger(snapshot)`, that throws a terminal error, the drainer then calls `engine.recordBufferedRunFailure(snapshot, error)` which writes a `SYSTEM_FAILURE` PG row directly — deliberately bypassing the normal lifecycle (no alerts, no realtime, no webhook) per the existing `recordBufferedRunFailure` design.

Customers can see these failed runs in their list/retrieve responses and may want to replay them. The contract has to match PG-side replay exactly.

## Audit of existing PG-side replay behaviour

Performed against `main` and the current `mollifier-phase-3` branch.

### `api.v1.runs.$runParam.replay.ts`

- Looks up the run by `friendlyId` via `prisma.taskRun.findUnique`. 404 if not found.
- Otherwise → `ReplayTaskRunService.call(taskRun, { triggerSource })`.
- **No status check.** Any run that exists, regardless of `status`, is eligible.

### `ReplayTaskRunService.call`

- Refuses only if `authenticatedEnvironment.archivedAt` is set (throws `"Can't replay a run on an archived environment"`).
- **No status check.**
- Pulls payload, metadata, tags, machine preset, concurrency key, region (V2 non-dev only), realtime streams version, traceContext (re-uses original's traceId/spanId) from the existing PG row.
- Calls `new TriggerTaskService().call(...)`, which routes V1/V2 → for V2, goes through `RunEngineTriggerTaskService` → which runs `evaluateGate` → which means the new replay can itself be mollified by the gate.

### Conclusion of the audit

PG-side replay of `SYSTEM_FAILURE` runs **already works today** on `main`. No special refusal, no error message. The contract is: any non-archived run is replayable.

Therefore buffered replay needs to behave identically — no status check, single code path regardless of state.

## Design

### One code path, regardless of run state

```ts
async function replay(originalRunId: string, overrides: OverrideOptions) {
  // Resolve the run from wherever it lives.
  // - PG canonical if the row exists (any status).
  // - Otherwise synthesise a TaskRun-shaped object from the buffer snapshot.
  // - Otherwise 404.
  const resolved = await withRunIdResolution(originalRunId, env);
  if (!resolved) {
    throw new Response("Run not found", { status: 404 });
  }

  // ReplayTaskRunService takes a TaskRun. Pass either the real one or the
  // synthesised-from-snapshot one. The service reads the same fields
  // (payload, payloadType, runTags, traceId, spanId, concurrencyKey,
  // machinePreset, workerQueue, engine, isTest, seedMetadata,
  // seedMetadataType, realtimeStreamsVersion) from either shape.
  const newRun = await new ReplayTaskRunService().call(resolved.asTaskRun, overrides);
  return { id: newRun.friendlyId };
}
```

The synthesis happens inside the resolver — the call site never has to know which storage the original came from.

### Why no per-state branching is needed

| State the original is in | What replay sees | What replay does |
|---|---|---|
| 1. PG row, any status (including `SYSTEM_FAILURE`) | PG-first resolver returns the real TaskRun | Call existing service, gate-aware new trigger |
| 2. Buffer entry, `status=QUEUED` | PG miss → buffer entry present → synthesise TaskRun | Same as above |
| 3. Buffer entry, `status=DRAINING` | PG miss → buffer entry present (immutable `payload` field, safe to read) | Same as above |
| 4. Buffer entry, `status=FAILED`, no PG row yet (vanishing race window) | PG miss → buffer entry present | Same as above — see "State 3 race window" below |
| 5. Buffer entry, `materialised=true` + PG row exists | PG-first resolver returns the real TaskRun (entry hash is a stale safety net at this point) | Call existing service |
| 6. Nothing exists | 404 | (no-op) |

The drainer's bifurcation work for `cancel` (Q4) does not apply here — replay never mutates the original run, never coordinates with the drainer, never waits for materialisation.

### Why this doesn't cause a surge

A customer might bulk-replay many failed buffered runs during a burst. Each replay creates a new trigger via `TriggerTaskService.call`. **Each new trigger re-enters the mollifier gate** (V2 only — V1 bypasses by design). If the env is still in burst state, those replays themselves get mollified into the buffer. The gate dampens load identically for fresh triggers and replays — replay can't amplify a surge beyond what the gate already absorbs.

Replay is therefore **not a special case** for surge protection. It piggybacks on the existing gate behaviour.

### State 3 race window — locked as "allow"

State 3 is the microseconds-wide window between the drainer's `HSET status=FAILED` and the `engine.recordBufferedRunFailure` PG write. Two options were considered:

- **Allow.** Customer doesn't know they hit the race; replay reads the snapshot, fires a new trigger, returns 200. Fully transparent.
- **Block.** Return `409 Retry` with `retryAfterMs` hint. Customer waits a few ms, retries, by then PG row exists. Less transparent.

**Decision: allow.** The `HSET status=FAILED` in Redis is itself a terminal commitment by the drainer — once executed, the original run is deterministically headed to SYSTEM_FAILURE in PG (or has already landed there). The replay creates a *separate* run with no causal dependency on the original's PG row existing yet.

### Trace context handoff

`ReplayTaskRunService.call` reuses the original's traceContext to span-link the new run:

```ts
traceContext: {
  traceparent: `00-${existingTaskRun.traceId}-${existingTaskRun.spanId}-01`,
}
```

The synthesised TaskRun (for buffered replay) must carry the same `traceId` and `spanId` — these are already in the engine snapshot's input (set by `triggerTask.server.ts` at line ~423 via `mollifierSpan.spanContext().traceId/spanId`). The resolver lifts them straight from the snapshot.

This matches the Q1 design's persistent-entry-hash decision: the snapshot's traceId/spanId are stable for the lifetime of the entry and across materialisation.

## Implementation

### Synthesised TaskRun shape

The resolver returns a `TaskRun`-shaped object built from the buffer snapshot. Every field `ReplayTaskRunService.call` reads must be populated:

| Field | Source in buffer snapshot |
|---|---|
| `id` (PG primary key) | Synthesised from `friendlyId` via `RunId.fromFriendlyId` |
| `friendlyId` | `entry.runId` |
| `runtimeEnvironmentId` | `snapshot.environment.id` |
| `engine` | `"V2"` (only V2 ever enters the buffer) |
| `taskIdentifier` | `snapshot.taskIdentifier` |
| `payload` | `snapshot.payloadPacket.data` |
| `payloadType` | `snapshot.payloadPacket.dataType` |
| `seedMetadata` | `snapshot.metadataPacket?.data` |
| `seedMetadataType` | `snapshot.metadataPacket?.dataType` |
| `runTags` | `snapshot.tags` |
| `traceId` | `snapshot.traceId` |
| `spanId` | `snapshot.spanId` |
| `concurrencyKey` | `snapshot.options?.concurrencyKey ?? null` |
| `machinePreset` | `snapshot.options?.machine ?? null` |
| `workerQueue` | `snapshot.workerQueue ?? null` |
| `isTest` | `snapshot.isTest ?? false` |
| `realtimeStreamsVersion` | `snapshot.realtimeStreamsVersion ?? null` |
| `queue` | `snapshot.queueName` |

Where `snapshot` is the deserialised `engineTriggerInput` from the buffer entry.

This synthesis lives next to `findRunByIdWithMollifierFallback` in `app/v3/mollifier/readFallback.server.ts` — it's an extension of the same fallback pattern, returning a `TaskRun`-shaped object instead of the abbreviated retrieve-shape that `findRunByIdWithMollifierFallback` returns today.

### Call site

`api.v1.runs.$runParam.replay.ts` swaps its `prisma.taskRun.findUnique` lookup for a `withRunIdResolution` call (the helper from `mollifier-api-parity.md`). All other logic stays identical.

The route handler also gets the route-level 404 cleanup that landed on the dashboard route earlier in this branch — `throw new Response("Run not found", { status: 404 })` instead of letting Prisma errors surface as 5xx leaks. Consistent across all run-id-shaped endpoints.

### V1 engine considerations

`TriggerTaskService` routes V1 vs V2 internally. V1 replays never go through the mollifier gate (V1 doesn't invoke `evaluateGate`). V1 runs also never enter the buffer in the first place — so a V1 run being replayed will always come from PG. No special handling needed at the replay layer.

## Test coverage

Three scenarios that must regression-pass:

1. **Replay of a PG-only run (any status).** Existing behaviour; assert the parity test still passes with status ∈ {`QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `SYSTEM_FAILURE`, `CANCELED`} on the original.
2. **Replay of a buffered `QUEUED` run.** Assert (a) replay returns 200 with a new runId, (b) new runId is distinct from original, (c) original is untouched in the buffer, (d) the new run's payload matches the original's snapshot payload, (e) the new run has `replayedFromTaskRunFriendlyId` set to the original.
3. **Replay during state 3 (FAILED in Redis, no PG row yet).** Assert replay still returns 200 from the buffer snapshot. Note: state 3 is microseconds wide so this test will need to inject a controlled state by writing `HSET status=FAILED` directly to a buffer entry without invoking the drainer's recordBufferedRunFailure.

These tests live in `apps/webapp/test/api/replay.test.ts` (new file) and use the same testcontainers + mocked-buffer pattern already established by `mollifierReadFallback.test.ts`.

## What this design does *not* cover

- Snapshot **mutation** during the buffered window (tags, metadata-put, reschedule, cancel) — separate doc, separate decisions (Q3 mutate-vs-drain race, Q4 cancel drainer-bifurcation, Q5 idempotency-key reset).
- Listing of replays in the runs table — replays appear as fresh new runs and follow the Q1 listing design unchanged.
- Bulk replay surfacing (dashboard bulk action) — same logic, called per item; needs no separate parity work.

## Open questions deferred

- **`prisma.taskRun.findUnique` anti-pattern in the existing route.** The webapp `CLAUDE.md` recommends `findFirst` instead due to Prisma's batching bugs. Pre-existing; documented as out-of-scope here but worth a follow-up cleanup PR.
- **Replay of `CANCELED` runs.** Currently allowed (no status check). Worth confirming this is intentional or whether `CANCELED` should be treated like other terminals or refused. Not blocking this parity work — whatever PG does today, buffered replay matches.
