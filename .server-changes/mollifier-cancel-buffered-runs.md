---
area: webapp
type: feature
---

Cancel API (`POST /api/v2/runs/{id}/cancel`) now works on buffered runs. Per the Q4 mollifier-cancel design:

- `engine.createCancelledRun` (new method in `@internal/run-engine`): writes a `CANCELED` TaskRun row directly from a buffer snapshot, bypassing the trigger/queue pipeline. Skips run-queue insertion (no execution needed), waitpoint creation (single-`triggerAndWait` can't enter the buffer), and concurrency reservation. Emits `runCancelled` so the existing handler writes the TaskEvent cancellation row. Idempotent: P2002 unique-constraint violations from double-pop after a drainer requeue return the existing row without re-emitting.

- Drainer bifurcation (`mollifierDrainerHandler.server.ts`): when the snapshot carries `cancelledAt`, route to `createCancelledRun` instead of `engine.trigger`. Cancel-wins-over-trigger ordering — customer intent is terminal.

- Cancel route (`api.v2.runs.$runParam.cancel.ts`): wraps the call in `mutateWithFallback`. PG-row hits go through the existing `CancelTaskRunService`. Buffered-run hits land a `mark_cancelled` patch on the snapshot via `mutateSnapshot`. `busy` snapshots wait for drainer resolution then call the PG service against the resulting row. Genuine 404s and timeouts surface as 404/503 respectively.
