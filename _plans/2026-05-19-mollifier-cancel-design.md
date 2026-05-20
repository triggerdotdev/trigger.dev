# Mollifier cancel — drainer bifurcation design

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-19
**Status:** Locked. (Q4 in the api-parity plan series.)
**Companion docs:** `2026-05-19-mollifier-listing-design.md` (Q1), `2026-05-19-mollifier-replay-design.md` (Q2), `2026-05-19-mollifier-mutation-race-design.md` (Q3).

## The question

`POST /api/v2/runs/{id}/cancel` on a buffered run can't just delete the entry — a cancelled run is a real customer-visible artefact and must materialise as a `CANCELED` PG row. The drainer must learn to write that row directly instead of calling `engine.trigger`.

## Audit findings — what shaped the design

### `runCancelled` event has exactly one listener

Searched every `engine.eventBus.on(...)` call across `apps/webapp/app/v3/`. Result:

```
runCancelled  →  runEngineHandlers.server.ts:363-414
                 — writes a TaskEvent row via `eventRepository.cancelRunEvent`
```

That's the entire downstream chain. **PG-side cancel today fires no alerts, no webhooks, no separate realtime emissions.** Only `runFailed` triggers alerts. Cancel is intentionally minimal.

Implication for `engine.createCancelledRun`: just emit `runCancelled`. The existing handler writes the TaskEvent. No additional side-effect plumbing.

### `engine.cancelRun` is idempotent on already-finished runs

`runAttemptSystem.ts:1306-1364`:

```ts
if (latestSnapshot.executionStatus === "FINISHED") {
  if (bulkActionId) { /* push bulkAction */ }
  return { alreadyFinished: true, ...executionResultFromSnapshot(latestSnapshot) };
}
```

Already-finished runs (any terminal status — CANCELED, COMPLETED, FAILED, SYSTEM_FAILURE) return `alreadyFinished: true` without error. Customer calling cancel on a cancelled run gets a successful response, the second call a no-op.

Implication for buffered-side: double-cancel is naturally idempotent via Lua HSET overwrite. Second call's `mutateSnapshot('mark_cancelled', ...)` sees the entry already has `cancelledAt` set and just re-writes the same value. No special handling needed.

### Idempotency-key reset is field-level only

`ResetIdempotencyKeyService.call()`: pure `prisma.taskRun.updateMany` setting `idempotencyKey: null, idempotencyKeyExpiresAt: null` on matching rows. **No separate dedup index — Redis or PG.** Idempotency dedup is `findFirst({ where: idempotencyKey, ... })` against the TaskRun column directly.

Implication for Q4: PG-side cancel doesn't touch `idempotencyKey`. Buffered side mirrors — the snapshot's `idempotencyKey` field stays intact when `cancelledAt` is patched. The drainer's `createCancelledRun` writes the PG row with the key still set. Subsequent trigger with that key returns the cancelled run (matches PG behaviour).

(Q5 also affected — the reset endpoint becomes a simple field-update, but with a buffer-scan-by-attribute requirement on the buffered side. Separate doc.)

## Design

### API side

The cancel route calls the Q3 wait-and-bounce helper with `mutateWithFallback`:

```ts
return mutateWithFallback({
  runId,
  envId: authenticatedEnvironment.id,
  orgId: authenticatedEnvironment.organizationId,
  bufferPatch: {
    type: "mark_cancelled",
    cancelledAt: new Date().toISOString(),
    cancelReason: body.reason ?? "Canceled by user",
  },
  pgMutation: async (taskRun) => {
    const result = await new CancelTaskRunService().call(taskRun, { ... });
    return json({ id: taskRun.friendlyId }, { status: 200 });
  },
  synthesisedResponse: () =>
    json({ id: runId }, { status: 200 }),
});
```

Three outcomes (per Q3):

| Buffer state | Path taken | Customer sees |
|---|---|---|
| PG row exists (any status) | `pgMutation` → existing `CancelTaskRunService` | 200 (idempotent if already cancelled) |
| Buffer entry `QUEUED` | Lua marks snapshot.cancelledAt, returns `applied_to_snapshot` | 200 synthesised; drainer will create CANCELED PG row |
| Buffer entry `DRAINING` / `FAILED` / `materialised=true` | Wait-and-bounce → `pgMutation` once PG row exists | 200 from existing service, or 4xx if endpoint-specific terminal rules apply |
| Neither PG nor buffer has the run | 404 | 404 |

### `mutateSnapshot` Lua — `mark_cancelled` patch type

```lua
applyPatchToPayload(payload, 'mark_cancelled', data):
  local d = cjson.decode(data)
  payload.cancelledAt = d.cancelledAt
  payload.cancelReason = d.cancelReason
```

Existing Lua flow from Q3:
- Status `QUEUED` and not `materialised=true` → patch snapshot, return `applied_to_snapshot`.
- Anything else → return `busy`.

Cancel inherits the same race-handling: if the entry is `DRAINING` when cancel lands, the API waits for materialisation then calls `CancelTaskRunService` against the now-existing PG row.

### Drainer bifurcation

In `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`:

```ts
export function createDrainerHandler(deps: {
  engine: RunEngine;
  prisma: PrismaClientOrTransaction;
}): MollifierDrainerHandler<MollifierSnapshot> {
  return async (input) => {
    const snapshot = input.payload as Record<string, unknown>;

    // Cancel-wins-over-fail: customer intent is terminal; check first,
    // before any engine.trigger try/catch path.
    if (typeof snapshot.cancelledAt === "string") {
      await deps.engine.createCancelledRun({
        snapshot,
        cancelledAt: new Date(snapshot.cancelledAt),
        cancelReason:
          typeof snapshot.cancelReason === "string"
            ? snapshot.cancelReason
            : "Canceled by user",
      });
      return;
    }

    // Normal materialisation — existing trace-context propagation + engine.trigger.
    const parentContext = buildParentContextFromSnapshot(snapshot);
    await context.with(parentContext, async () => {
      await startSpan(tracer, "mollifier.drained", async (span) => {
        // ... existing span attributes ...
        await deps.engine.trigger(input.payload as any, deps.prisma);
      });
    });
  };
}
```

The cancel branch is the *only* new code path. Everything else preserves today's behaviour.

### `engine.createCancelledRun` — new method in run-engine

In `internal-packages/run-engine/src/engine/index.ts`:

```ts
async createCancelledRun(input: {
  snapshot: EngineTriggerInput;
  cancelledAt: Date;
  cancelReason: string;
}): Promise<TaskRun> {
  return startSpan(this.tracer, "createCancelledRun", async () => {
    const taskRun = await this.prisma.taskRun.create({
      data: {
        id: RunId.fromFriendlyId(input.snapshot.friendlyId),
        engine: "V2",
        status: "CANCELED",
        friendlyId: input.snapshot.friendlyId,
        runtimeEnvironmentId: input.snapshot.environment.id,
        environmentType: input.snapshot.environment.type,
        organizationId: input.snapshot.environment.organizationId,
        projectId: input.snapshot.environment.projectId,
        taskIdentifier: input.snapshot.taskIdentifier,
        payload: input.snapshot.payloadPacket.data,
        payloadType: input.snapshot.payloadPacket.dataType,
        context: {},
        traceContext: input.snapshot.traceContext,
        traceId: input.snapshot.traceId,
        spanId: input.snapshot.spanId,
        parentSpanId: input.snapshot.parentSpanId,
        runTags: input.snapshot.tags ?? [],
        idempotencyKey: input.snapshot.idempotencyKey,
        idempotencyKeyExpiresAt: input.snapshot.idempotencyKeyExpiresAt,
        queue: input.snapshot.queueName ?? `task/${input.snapshot.taskIdentifier}`,
        lockedQueueId: input.snapshot.lockedQueueId,
        workerQueue: input.snapshot.workerQueue,
        depth: input.snapshot.depth ?? 0,
        parentTaskRunId: input.snapshot.parentTaskRunId,
        rootTaskRunId: input.snapshot.rootTaskRunId,
        replayedFromTaskRunFriendlyId: input.snapshot.replayedFromTaskRunFriendlyId,
        batchId: input.snapshot.batch?.id,
        resumeParentOnCompletion: input.snapshot.resumeParentOnCompletion ?? false,
        isTest: input.snapshot.isTest ?? false,
        taskEventStore: input.snapshot.taskEventStore,
        seedMetadata: input.snapshot.metadataPacket?.data,
        seedMetadataType: input.snapshot.metadataPacket?.dataType,
        machinePreset: input.snapshot.options?.machine,
        concurrencyKey: input.snapshot.options?.concurrencyKey,
        oneTimeUseToken: input.snapshot.oneTimeUseToken,
        completedAt: input.cancelledAt,
        error: {
          type: "STRING_ERROR",
          raw: input.cancelReason,
        } as Prisma.InputJsonObject,
      },
    });

    // Single side effect: emit so the existing runCancelled handler writes
    // the TaskEvent. Per audit, this is the only downstream listener on
    // PG-side cancel — no alerts, no webhooks.
    this.eventBus.emit("runCancelled", {
      time: input.cancelledAt,
      run: {
        id: taskRun.id,
        spanId: taskRun.spanId,
        error: taskRun.error as TaskRunError,
      },
    });

    return taskRun;
  });
}
```

### Why no queue insertion

The run is terminal from the moment it materialises. No dequeue path will run it. The queue insert is purely how runs reach workers — cancelled runs never go to workers. Skipping it is correct.

### Why no waitpoint creation

Waitpoints exist so parent runs can resume when this child completes. A cancelled run that never executes can't have a parent waiting on it via the normal lifecycle. If a parent *did* call `triggerAndWait`, that path goes through the F4 bypass (mollifier gate refuses to buffer single-triggerAndWait), so a buffered run can't have a parent waitpoint. The waitpoint case is structurally impossible here.

## Sub-decisions resolved

| # | Decision | Resolution |
|---|---|---|
| 4a | Side-effect chain | Emit `runCancelled` event only; downstream handlers already do the right thing (TaskEvent row write). Per audit, no alerts/webhooks to wire. |
| 4b | Cancel-wins-over-fail ordering | Cancel check happens first in the drainer's bifurcation. Customer intent is terminal. |
| 4c | Idempotency-key interaction | No-op. Mirrors PG-side which leaves `idempotencyKey` intact on cancel. Snapshot's key stays; drainer's `createCancelledRun` writes PG row with key set. Subsequent trigger with the same key returns the cancelled run. |

## Behaviour table

| Scenario | API response | PG end state | Side effects |
|---|---|---|---|
| Cancel a buffered `QUEUED` run | 200 (synthesised) | `CANCELED` row created by drainer's `createCancelledRun` on next pop | TaskEvent CANCELED row via the runCancelled handler |
| Cancel a buffered `DRAINING` run | 200 (via wait-and-bounce, Q3) | If drainer succeeds: `QUEUED` row → cancel applies via existing `CancelTaskRunService`. If drainer fails: `SYSTEM_FAILURE` row → `CancelTaskRunService` returns `alreadyFinished:true`. | Existing PG-side side effects |
| Cancel a buffered state-3 (`FAILED` pre-PG) | 200 (Q3 wait converges on `SYSTEM_FAILURE` PG row) | `SYSTEM_FAILURE` row + `alreadyFinished:true` from cancel service | Existing PG-side side effects |
| Cancel an already-cancelled buffered run | 200 (Lua HSET overwrite is idempotent) | Same `CANCELED` row materialised by drainer | Single TaskEvent CANCELED row (idempotent — drainer creates once) |
| Cancel an already-cancelled PG run | 200 (`alreadyFinished:true` from existing service) | Unchanged | None (existing service skips re-emission) |
| Cancel a non-existent run | 404 | n/a | n/a |

## Forward-compatibility under rolling update

`cancelledAt` and `cancelReason` are new semantic-bearing fields on the snapshot's `payload` JSON. Old drainers don't know to check them. Strict deploy order required (per the May-15 review):

1. **Ship the new drainer first.** Bifurcation logic recognises `cancelledAt`, falls through to existing `engine.trigger` when absent. Behaves identically to today when the API hasn't been updated.
2. **Wait for rolling update to complete.** All drainer replicas running the new code.
3. **Ship the new API.** Cancel route starts writing `cancelledAt` to snapshots.

Between steps 1 and 3, the new drainer runs but no cancels write the field — so it's dormant. Between steps 2 and 3, all drainers know about `cancelledAt` and the API hasn't started writing it yet — also safe.

`BufferEntrySchema` audit confirmed Zod's default strip behaviour (no `.strict()`), so the snapshot's inner JSON tolerates unknown fields. New fields don't crash old parsers.

## What `engine.createCancelledRun` doesn't do

Things `engine.trigger` does that `createCancelledRun` deliberately skips:

- Run queue insert (no execution needed).
- Waitpoint creation (no parent waitable on this synchronously-cancelled run; F4 bypass prevents single-triggerAndWait from entering buffer).
- Concurrency limit reservation (no execution slot consumed).
- Idempotency-key dedup check (the key is on the snapshot; we honour whatever the original trigger registered, but a cancelled row keeps the key per PG-side semantics).

Things it does that `recordBufferedRunFailure` skips but cancel needs:

- Emit the event-bus event. recordBufferedRunFailure deliberately bypasses alerts/realtime/webhook because "rows that never reached the engine; the normal pipeline's assumptions don't hold." Cancel is different — it's customer intent, not a system event, and the only side effect (TaskEvent write) is appropriate.

## Test coverage

Unit tests in `internal-packages/run-engine/src/engine/tests/createCancelledRun.test.ts`:

1. Inserts PG row with `status: "CANCELED"`, all snapshot fields preserved.
2. Emits `runCancelled` event with correct payload.
3. Idempotent on existing row with same friendlyId (Prisma `create` would throw on conflict — confirm we handle this if double-drain ever happens; probably should be `findFirst-then-upsert` or `try/catch P2002`).
4. Skips run-queue insertion (mock the queue, assert no insert calls).
5. Sets `completedAt` and `error.raw` to the cancellation reason.

Drainer-bifurcation tests in `apps/webapp/test/mollifierDrainerHandler.test.ts`:

6. Snapshot with `cancelledAt` → calls `engine.createCancelledRun`, does *not* call `engine.trigger`.
7. Snapshot without `cancelledAt` → calls `engine.trigger`, does *not* call `engine.createCancelledRun`.
8. Snapshot with `cancelledAt` AND `engine.trigger` would have thrown → cancel-wins, `createCancelledRun` called.

End-to-end test in `apps/webapp/test/api/cancel-buffered.test.ts`:

9. Buffer entry `QUEUED` → API call returns 200, drainer pops, PG row created in `CANCELED` state, TaskEvent CANCELED row written, full snapshot fields preserved.
10. Buffer entry transitions: cancel-during-drainer-pop race resolves correctly (the cancel wins via Q3 wait-and-bounce path landing on the new PG row).

## Files touched

**New:**
- `internal-packages/run-engine/src/engine/tests/createCancelledRun.test.ts`.
- `apps/webapp/test/api/cancel-buffered.test.ts`.

**Modified:**
- `internal-packages/run-engine/src/engine/index.ts` — add `createCancelledRun` method.
- `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts` — bifurcation on `cancelledAt`.
- `apps/webapp/app/routes/api.v2.runs.$runParam.cancel.ts` — switch to `mutateWithFallback`.
- `packages/redis-worker/src/mollifier/buffer.ts` — `mark_cancelled` patch type in `mutateSnapshot` Lua dispatch (added under Q3's infra work).
- `apps/webapp/test/mollifierDrainerHandler.test.ts` — bifurcation tests.

## Risks specific to cancel

- **`engine.createCancelledRun` writes PG row directly.** If a drainer retry causes double-pop (entry was requeued for any reason), we'd attempt to create the same friendlyId twice. Prisma P2002 unique constraint catches it; treat as idempotent success.
- **Cancel-during-cancel race.** Two cancel API calls land on the same buffered run within microseconds. Lua atomicity serialises: both end up writing the same `cancelledAt`/`cancelReason` value. Lossy if they had different reasons — the later write wins. Mirror PG-side behaviour (which has the same "last-write-wins" semantics on concurrent cancels).
- **Cancel after materialise but during grace window.** Entry has `materialised=true`; PG has the row. Q3's wait-and-bounce sees the PG row immediately via writer-side check, calls existing `CancelTaskRunService` (which is idempotent on already-cancelled). Customer's request takes ~ms.
- **Drainer crash after PG insert but before event emission.** PG row exists in `CANCELED` state, but no `runCancelled` event fired → no TaskEvent row. On drainer restart, sweeper finds the entry in DRAINING state with PG row materialised; we'd need to detect this and re-emit. Acceptable to add as a known recovery edge for the drainer-sweeper work that also covers Q3.

## What this design does NOT cover

- The Q5 idempotency-key reset endpoint — separate doc once we audit how it interacts with buffer state.
- Dashboard cancel button (`/resources/taskruns/{runParam}/cancel`) — reuses this design via Phase D of the master plan.
- Bulk cancel — the bulkAction path passes `bulkActionId` through to `cancelRun`. `createCancelledRun` accepts it as input and writes to `bulkActionGroupIds` for parity. Same shape, no design difference.
