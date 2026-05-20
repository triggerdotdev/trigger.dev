---
area: webapp
type: improvement
---

Wire the mollifier buffer's idempotency surface into the trigger hot path per Q5. Three connected changes:

- `IdempotencyKeyConcern.handleTriggerRequest` now falls through to `buffer.lookupIdempotency` after a PG miss. A buffered cache hit synthesises a TaskRun via the existing `findRunByIdWithMollifierFallback` and returns `{ isCached: true, run }`. Skipped when `resumeParentOnCompletion` is set: blocking a parent on a buffered child via waitpoint requires a PG row that doesn't exist yet, and the follow-up accept's SETNX still catches the duplicate trigger itself. Buffer outages fail open to "no cache hit" so the trigger hot path can't be wedged by a transient Redis issue.

- `mollifyTrigger` passes `idempotencyKey` + `taskIdentifier` through to `MollifierBuffer.accept`. When the buffer's SETNX races with another concurrent buffered trigger using the same key, the race loser receives `{ kind: "duplicate_idempotency", existingRunId }` and the API response echoes the winner's runId with `isCached: true`, matching PG-side cache-hit shape.

- `ResetIdempotencyKeyService` calls `buffer.resetIdempotency` alongside the existing PG `updateMany`. The 404 only fires when both stores report nothing was bound. A buffer outage during reset is logged and treated as a miss — the PG side still works.
