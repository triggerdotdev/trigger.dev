---
area: webapp
type: fix
---

Tighten Phase 2 batch-stream idempotency across all three branches of
`StreamBatchItemsService.call` so a successful original request, or a
retry of one, returns `sealed:true` instead of the customer-visible
422/`sealed:false` responses that surfaced as `BatchTriggerError` in
production.

Three related modes are now handled uniformly:

1. **TRI-9944 (lost-response retry)**: SDK retries Phase 2 after a
   network blip ate the response. The original sealed the batch; the
   retry hits a non-`PENDING` status and the pre-loop check threw 422.

2. **Sealed-with-callback PENDING**: the V2 `batchCompletionCallback`
   resets status from `PROCESSING` back to `PENDING` when every run
   was created cleanly, without touching `sealed`. The seal-failed
   race branch threw "unexpected state" on this perfectly legitimate
   state.

3. **Cleanup-race (customer 4-item batchTriggerAndWait reports)**:
   BatchQueue rushes through every item before the loop finishes its
   seal step, the callback fires (setting `processingCompletedAt`),
   `cleanup()` deletes the Redis metadata, then the service's
   `getBatchEnqueuedCount` returns 0 ≠ `runCount`. The count-mismatch
   branch returned `sealed:false` because `sealed=false + PENDING`
   wasn't distinguishable from "client should stream more items". The
   SDK then retried the stream against the cleaned-up batch, the
   engine threw `Batch not found or not initialized`, retries
   exhausted, customer saw `BatchTriggerError` despite every child run
   completing successfully.

The pre-loop check, the count-mismatch handler, and the seal-failed
handler now all call a single `isIdempotentRetrySuccess(status, sealed,
processingCompletedAt)` helper. `processingCompletedAt` is the
discriminator that fixes mode (3) — it's set exclusively by the V2
completion callback, so `(status=PENDING) && (sealed || processingCompletedAt
!= null)` cleanly separates "callback fired, work is done" from "client
should stream more items".

`ABORTED` (zero TaskRun records — every run-creation attempt failed
*and* the pre-failed-TaskRun fallback also failed) is explicitly
excluded from the idempotent-success path in all three branches: the
customer has nothing to monitor at the run level, so the trigger call
must throw to give their `batchTrigger()` retry the chance to create a
fresh batch.
