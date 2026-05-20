---
area: webapp
type: feature
---

Dashboard mutation routes handle buffered runs (Phase D — parallels Phase C's API-side work).

- `POST /resources/taskruns/{runParam}/cancel`: PG miss falls through to `buffer.mutateSnapshot('mark_cancelled')`. Org-membership is verified against the buffered run's `orgId` (the dashboard URL doesn't carry an envId so the API-side env-scoped auth doesn't apply). `busy` returns a "retry in a moment" message.
- `POST /resources/taskruns/{runParam}/replay`: PG miss falls through to `findRunByIdWithMollifierFallback`; the B4-extended `SyntheticRun` is cast to `TaskRun` and fed to `ReplayTaskRunService`. Project/env slugs needed for the success-redirect are looked up from the entry's `envId`.
- `POST /resources/orgs/.../runs/{runParam}/idempotencyKey/reset`: PG miss falls through to buffer; reads `idempotencyKey` + `taskIdentifier` from the snapshot; org-membership verified against the entry's `orgId`. The existing `ResetIdempotencyKeyService` (extended in B6b to clear both stores) handles the actual reset.
