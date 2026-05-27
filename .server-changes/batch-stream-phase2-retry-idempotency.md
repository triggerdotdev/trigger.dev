---
area: webapp
type: fix
---

Treat Phase 2 batch-stream retries as idempotent when the batch has
already been sealed or moved past `PENDING` (TRI-9944).

When the SDK created a batch and then streamed its items (Phase 2 of
the 2-phase batch API), a lost response would trigger the SDK's
network-retry path. For small, fast-completing batches the original
request had already enqueued every item, sealed the batch, and let the
runs flip the batch to `PROCESSING` or even `COMPLETED` by the time the
retry arrived. The retry then failed the pre-loop check at
`apps/webapp/app/runEngine/services/streamBatchItems.server.ts:109`
with a 422 — surfacing a customer-visible `BatchTriggerError` for a
batch whose runs had actually succeeded.

`StreamBatchItemsService.call` now returns the standard `sealed: true`
success response (with `itemsAccepted: 0`, `itemsDeduplicated: 0`,
`runCount: batch.runCount`) when the batch is already sealed or in
`PROCESSING`/`COMPLETED`, matching the idempotency already applied at
the two post-loop race-condition branches in the same file.
`ABORTED` and other unexpected non-`PENDING` states still throw.
