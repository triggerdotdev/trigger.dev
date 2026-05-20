---
area: webapp
type: feature
---

`PUT /api/v1/runs/{id}/metadata` now handles buffered runs (Phase C3). Closes the last endpoint in the mollifier API-parity master plan.

PG remains canonical when the row exists — `UpdateMetadataService.call` owns the full request shape including parent/root operations, the metadataVersion CAS loop, batching, and validation. The route falls through to the buffer only when the existing service returns `undefined` (no PG row).

Buffer path uses a new `applyMetadataMutationToBufferedRun` helper that mirrors the PG service's optimistic-lock pattern: read the snapshot, apply the body's `metadata` replace + `operations` deltas in JS via the existing `applyMetadataOperations` from `@trigger.dev/core`, CAS-write back via `buffer.casSetMetadata`, retry on `version_conflict` up to 3 times. Concurrent `metadata.increment` / `metadata.set` / `metadata.append` calls against the same buffered run never lose deltas.

`busy` (entry is DRAINING or already materialised) and `version_exhausted` (pathological contention) return 503 with a retry hint. `not_found` returns 404.

`parentOperations` and `rootOperations` on a buffered target run are fanned out to the snapshot's `parentTaskRunId` via the existing service (parent is typically PG-materialised by the time the child enters the buffer). If the parent is also buffered, the helper recurses through the same CAS path. Best-effort — parent/root ingestion failures do not surface to the caller.
